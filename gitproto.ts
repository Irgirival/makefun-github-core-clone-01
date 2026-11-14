// gitproto.ts — git smart HTTP, implemented from the wire up.
//
// No git binary exists in the trial pod, so this module speaks the protocols
// itself, on node:zlib / node:crypto only (via store.ts):
//   - pkt-line framing (0000 flush, 0001 delim, 0002 response-end, 4-hex length)
//   - protocol v2 capability advertisement, ls-refs and fetch
//   - protocol v0 upload-pack (want/have/done/deepen, side-band-64k) and
//     receive-pack (command list, pack, report-status over side-band-64k)
//   - packfile writing (plain objects; the suite's client never sends deltas,
//     and this server never needs to)
//
// The handlers take the raw request body and return {status, contentType, body}
// for app.ts to send. They never throw out to the server: a malformed request
// answers 400 and the server stays up (the suite checks exactly that).

import {
  ZERO_OID,
  applyDelta,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a whole buffer of pkt-lines; throws on a malformed header. */
export function decodePktLines(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

export function pktLinesText(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Sideband
// ---------------------------------------------------------------------------------------------

/** Split pack bytes into sideband band-1 pkt-lines (each <= 65520 bytes framed). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // 65520 - 4 (pkt header) - 1 (band byte)
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Ref helpers
// ---------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, sorted, with HEAD first where it applies. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  out.push({
    oid: defaultTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: defaultRef,
    unborn: defaultTip === undefined,
  });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      try {
        entry.peeled = parseTag(object.data).object;
      } catch {
        // not a parseable tag; leave unpeeled
      }
    }
    out.push(entry);
  }
  return out;
}

/** Peel a ref to its commit when it names an annotated tag object. */
export function peelOid(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object?.type === 'tag') {
    try {
      return parseTag(object.data).object;
    } catch {
      return oid;
    }
  }
  return oid;
}

// ---------------------------------------------------------------------------------------------
// Fetch object selection (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

export interface FetchSelection {
  /** Objects to send, in a deterministic order. */
  objects: GitObject[];
  /** Commits included whose parents were cut off (the shallow boundary). */
  shallow: string[];
  /** Previously-shallow commits now fully included. */
  unshallow: string[];
}

/**
 * Which objects a fetch sends.
 *
 * `wants` are the tips; `haves` are commits the client already holds, with
 * `shallowBoundaries` naming the client's current shallow boundary (parents of
 * those commits are NOT held). `depth` limits generations from the wants.
 * The sent set is the depth-limited reachable closure of the wants minus what
 * the client holds.
 */
export function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
  deepenRelative = false,
): FetchSelection {
  const lookup = repo.lookup;
  // What the client already holds: reachable from the haves, not crossing a
  // shallow boundary (a boundary commit's own tree/blobs are held, its parents
  // are not).
  const held = new Set<string>();
  if (haves.length > 0) {
    try {
      for (const oid of collectReachable(haves, lookup, { stopAt: new Set(shallowBoundaries) })) held.add(oid);
    } catch {
      // A have the server does not know: the client holds nothing we can prove.
      held.clear();
    }
  }
  // Depth-limited reachable closure of the wants. A queue entry carries its
  // generation from the wants, and `rel`, the generations below the nearest
  // shallow boundary on the path to it (-1 while no boundary has been
  // crossed; a boundary commit itself sits at rel 0). A tag dereferences at
  // the same generation and rel as the tag itself (a tag is not a generation
  // of history). A `deepen N` without `deepen-relative` is an ABSOLUTE depth
  // from the wants (what a depth-1 clone and the suite's deepen use): the
  // cut is by generation. With `deepen-relative` (real git's --deepen) the
  // cut only applies below a boundary, by generations below it: commits at
  // or above a boundary are always traversed, and the budget counts the new
  // generations the deepen delivers.
  const wanted = new Set<string>();
  const wantedCommits: string[] = [];
  const shallow: string[] = [];
  const seenCommits = new Set<string>();
  const boundarySet = new Set(shallowBoundaries);
  const queue: Array<{ oid: string; generation: number; rel: number }> = [...new Set(wants)]
    .filter((oid) => isOid(oid) && repo.objects.has(oid))
    .map((oid) => ({ oid, generation: 0, rel: boundarySet.has(oid) ? 0 : -1 }));
  while (queue.length > 0) {
    const { oid, generation, rel: inheritedRel } = queue.shift()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      wantedCommits.push(oid);
      queue.push({ oid: parseTag(object.data).object, generation, rel: inheritedRel });
      continue;
    }
    if (object.type !== 'commit') continue;
    wantedCommits.push(oid);
    const commit = parseCommit(object.data);
    const isBoundary = boundarySet.has(oid);
    const rel = isBoundary ? 0 : inheritedRel;
    let includeParents: boolean;
    let parentRel: number;
    if (deepenRelative && depth !== undefined) {
      parentRel = isBoundary ? 1 : rel === -1 ? -1 : rel + 1;
      includeParents = parentRel <= depth;
    } else {
      parentRel = rel;
      includeParents = depth === undefined || generation + 1 < depth;
    }
    if (includeParents) {
      for (const parent of commit.parents) {
        if (!seenCommits.has(parent)) queue.push({ oid: parent, generation: generation + 1, rel: parentRel });
      }
    } else if (commit.parents.length > 0) {
      // At the depth cut: this commit is a shallow boundary when it has parents.
      shallow.push(oid);
    }
  }
  // Objects of the wanted commits (trees + blobs), minus what the client holds.
  const allWanted = new Set<string>();
  for (const oid of collectReachable(wantedCommits, lookup, { stopAt: new Set(shallow) })) allWanted.add(oid);
  // A wanted commit at the depth cut still contributes its tree/blobs; its
  // parents do not (collectReachable with stopAt handles that).
  for (const oid of wantedCommits) {
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const x of collectReachable([commit.tree], lookup)) allWanted.add(x);
    }
  }
  for (const oid of allWanted) wanted.add(oid);
  const send: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }
  // Unshallow: a previous boundary now included with its parents included too.
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (!wantedCommits.includes(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => wantedCommits.includes(parent))) unshallow.push(boundary);
  }
  return { objects: send, shallow: [...new Set(shallow)].sort(), unshallow: [...new Set(unshallow)].sort() };
}

// ---------------------------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------------------------

/** The v2 capability advertisement: `version 2` then capability lines, then flush. */
export function v2Advertisement(): Buffer {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

function capabilitiesString(caps: readonly string[]): string {
  return caps.join(' ');
}

/** The v0 ref advertisement for a service, with the `# service=` preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps =
    service === 'git-upload-pack'
      ? ['symref=HEAD:refs/heads/main', `agent=${AGENT}`, 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow']
      : ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];
  const refs = listRefs(repo);
  if (refs.length === 1 && refs[0].name === 'HEAD' && refs[0].unborn === true) {
    // Empty repository: the `capabilities^{}` pseudo-ref carries the capabilities.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilitiesString(caps)}\n`));
    parts.push(pktLine(`${ZERO_OID} HEAD\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  let first = true;
  for (const ref of refs) {
    if (ref.name === 'HEAD' && ref.unborn === true) continue;
    const line = first
      ? `${ref.oid} ${ref.name}\0${capabilitiesString(caps)}\n`
      : `${ref.oid} ${ref.name}\n`;
    parts.push(pktLine(line));
    first = false;
    if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

/** Handle a v2 ls-refs command; `args` are the lines after the delim packet. */
export function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.name === 'HEAD') {
      if (ref.unborn === true) {
        if (!unborn) continue;
        const attrs = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
        parts.push(pktLine(`unborn HEAD${attrs}\n`));
      } else {
        const attrs = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
        parts.push(pktLine(`${ref.oid} HEAD${attrs}\n`));
      }
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Fetch (v2 and v0 share the selection; only the framing differs)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  /** The client sent `done`: negotiation is over, send the pack. */
  done: boolean;
  /** The client sent `deepen-relative`: deepen counts from its boundary. */
  deepenRelative: boolean;
}

export function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], done: false, deepenRelative: false };
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line === 'done') out.done = true;
    else if (line === 'deepen-relative') out.deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
  }
  return out;
}

function buildPackForSelection(selection: FetchSelection): Buffer {
  // Always a pack, even an empty one: the packfile section is part of every
  // fetch response, and a client that asked for nothing new still expects
  // the section (with a zero-object pack) rather than the response ending.
  const objects = selection.objects.map((object) => ({ type: object.type, data: object.data }));
  return writePack(objects);
}

/** The deepest client 'have' that is already an ancestor of a wanted tip. */
function deepestCommonHave(repo: Repo, wants: readonly string[], haves: readonly string[]): string | null {
  let best: string | null = null;
  let bestDepth = -1;
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    for (const want of wants) {
      if (!isAncestor(repo.lookup, have, want)) continue;
      const depth = commitDepth(repo, have);
      if (depth > bestDepth) {
        best = have;
        bestDepth = depth;
      }
    }
  }
  return best;
}

/** Generation (distance from the root) of a commit, for ranking haves. */
function commitDepth(repo: Repo, oid: string): number {
  let depth = 0;
  let current: string | null = oid;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const obj = repo.lookup(current);
    if (!obj || obj.type !== 'commit') break;
    const parents = parseCommit(obj.data).parents;
    current = parents.length > 0 ? parents[0] : null;
    depth += 1;
  }
  return depth;
}

/** A v2 fetch response: acknowledgments, shallow-info, packfile sections. */
export function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const selection = selectFetchObjects(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth, parsed.deepenRelative);
  const pack = buildPackForSelection(selection);
  const parts: Buffer[] = [];
  // Protocol v2 acknowledgments, exactly as upload-pack sends them:
  //   - When the client sent `done` (every fetch over stateless HTTP does),
  //     there is NO acknowledgments section at all: the client has finished
  //     negotiating and expects shallow-info / packfile next. Sending one
  //     makes real git die ("expected 'packfile', received
  //     'acknowledgments'").
  //   - When the client sent haves but no `done`, the section is sent:
  //     one `ACK <oid>` line per common have, then a bare `ready` line of
  //     its own (never `ACK <oid> ready` on one line: the client's
  //     process_ack reads `ready` as a separate line and dies if the
  //     section ends with a delim without it), then a delim. With no common
  //     object at all the section is a bare `NAK` ended by a flush, and the
  //     response ends there: the client will send another request.
  if (parsed.haves.length > 0 && !parsed.done) {
    parts.push(pktLine('acknowledgments\n'));
    const common = deepestCommonHave(repo, parsed.wants, parsed.haves);
    if (common === null) {
      parts.push(pktLine('NAK\n'));
      parts.push(pktFlush());
      return Buffer.concat(parts);
    }
    parts.push(pktLine(`ACK ${common}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v0 fetch response: NAK, shallow lines, then the sideband pack. */
export function handleFetchV0(repo: Repo, args: readonly string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const selection = selectFetchObjects(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth, parsed.deepenRelative);
  const pack = buildPackForSelection(selection);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack: unpack the pack, then apply each command with
 * fast-forward checks. Returns the report lines for report-status.
 */
export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  // The command list runs to the first flush packet; everything after it is
  // the packfile (raw bytes, not pkt-framed). Parse pkt-lines incrementally so
  // the raw pack bytes after the flush are never fed to the pkt-line decoder.
  let offset = 0;
  const commands: PushCommand[] = [];
  let sawFlush = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) return { status: 400, body: Buffer.alloc(0) };
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) return { status: 400, body: Buffer.alloc(0) };
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length < 4 || offset + length > body.length) return { status: 400, body: Buffer.alloc(0) };
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const commandText = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = commandText.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      return { status: 400, body: Buffer.alloc(0) };
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    offset += length;
  }
  if (!sawFlush || commands.length === 0) return { status: 400, body: Buffer.alloc(0) };
  const packBytes = body.subarray(offset);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const entries = readPack(packBytes, { resolveBase: repo.lookup });
        for (const entry of entries) {
          if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpacker error';
      }
    }
  }
  const outcomes: PushOutcome[] = [];
  for (const command of commands) {
    outcomes.push(applyPushCommand(repo, command, unpackOk));
  }
  // report-status inside sideband band 1: the band-1 payload is itself a
  // sequence of pkt-lines ("unpack ok", "ok <ref>" / "ng <ref> <reason>")
  // and ends with a flush pkt-line of its own. The client demuxes band 1
  // into a pipe and reads it with a packet reader that has no gentle-EOF
  // option, so without that inner flush it dies with "the remote end hung
  // up unexpectedly" after the last status line. One sideband packet holds
  // the whole framed report; the outer stream then ends with a flush.
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const outcome of outcomes) {
    reportLines.push(outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`);
  }
  const reportFramed = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), reportFramed]))];
  parts.push(pktFlush());
  return { status: 200, body: Buffer.concat(parts) };
}

function applyPushCommand(repo: Repo, command: PushCommand, unpackOk: boolean): PushOutcome {
  const fail = (reason: string): PushOutcome => ({ ref: command.ref, ok: false, reason });
  if (!unpackOk) return fail('unpack failed');
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return fail('remote ref does not exist');
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return fail('non-fast-forward');
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true, reason: '' };
  }
  const target = repo.objects.get(command.newOid);
  if (!target) return fail('object not found');
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return fail('already exists');
    repo.refs.set(command.ref, command.newOid);
    return { ref: command.ref, ok: true, reason: '' };
  }
  // Update: old must match the current tip and new must descend from old.
  if (current === undefined) return fail('remote ref does not exist');
  if (command.oldOid !== current) return fail('non-fast-forward');
  if (target.type === 'commit') {
    if (!isAncestor(repo.lookup, command.oldOid, command.newOid)) return fail('non-fast-forward');
  } else if (target.type === 'tag') {
    // A tag update fast-forwards only when it points at the same object.
    if (command.newOid !== command.oldOid) return fail('non-fast-forward');
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}

// ---------------------------------------------------------------------------------------------
// Upload-pack entry point: dispatch v2 vs v0 by the Git-Protocol header.
// ---------------------------------------------------------------------------------------------

/** Parse a v2 request body into (command, args-after-delim). */
export function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const lines = pktLinesText(packets);
  if (lines.length === 0) return null;
  const first = lines[0].replace(/\n$/, '');
  if (!first.startsWith('command=')) return null;
  const command = first.slice('command='.length);
  // Arguments after the delim packet; the client sends them in a second group.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const after = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
  return { command, args: pktLinesText(after) };
}

/** Parse a v0 upload-pack body into two sections: wants, then haves/done. */
export function parseV0Request(body: Buffer): string[] {
  const packets = decodePktLines(body);
  return pktLinesText(packets);
}
