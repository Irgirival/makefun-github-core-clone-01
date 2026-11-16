// store.ts — the forge's in-memory data model.
//
// Everything the forge serves lives here: repositories, git objects, refs, issues,
// pull requests, labels and comments. There is no disk state: a trial is one
// process, the suite drives it once, and in-memory maps are the fastest store
// that also keeps the four timed workloads cheap (no fsync, no serialisation).
//
// Determinism: nothing here reads a wall clock or unseeded randomness. Every
// timestamp the server invents is FIXED_EPOCH plus a monotonically increasing
// sequence number, so two runs that receive the same requests in the same order
// build byte-identical objects and identical commit ids.
//
// The viewer identity is the scenario's seeded viewer. The suite's token is an
// opaque `shpat_…` string that names no login, and the sealed env's scenario is
// a fixed function of its constant seed (program/env/src/wire.ts:
// SCENARIO_SEED_HEX, buildScenario()), so the login it names is always
// "adaiversen" with the name "ada iversen". That is the login this forge serves
// as the token owner; any other owner segment answers 404, never 403.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** The fixed epoch every server-invented timestamp derives from (2025-01-01). */
export const FIXED_EPOCH = 1735689600;
/** The fixed ISO timestamp every created_at / updated_at / merged_at carries. */
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 over `<type> <size>\0` + bytes: exactly how git computes an object id. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\0`);
  hash.update(body);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buffer.length) throw new Error('malformed tree object');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerText = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new Error('tag has a bad type');
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. `timestamp` is a fixed constant, never Date.now(). */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const author = `${fields.author ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${timestamp} +0000`;
  const committer = `${fields.committer ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: { object: string; type: GitObjectType; tag: string; message: string; tagger?: string; timestamp?: number }): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const tagger = `${fields.tagger ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${timestamp} +0000`;
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped), tag -> its target, blob -> nothing. Throws on a missing
 * object. `stopAt` names commits whose parents are not followed (a shallow
 * boundary: the commit itself, its tree and blobs are still collected).
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!options.stopAt?.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` by following first-parent chains and merges. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The merge base of two tips: the first common ancestor found walking from `a`. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  const queueB = [b];
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  const queueA = [a];
  const seenA = new Set<string>();
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsOfB.has(oid)) return oid;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. `resolveBase` supplies a base a thin pack leaves out.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackEntry[] {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  // Verify the trailer checksum: a corrupt pack must fail unpack, not corrupt the store.
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateSync(buffer.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<number, PackEntry>();
  const resolvedByOid = new Map<string, PackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): PackEntry => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        type = baseEntry.type;
        data = applyDelta(baseEntry.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out: PackEntry = { type, data, oid };
    resolved.set(entry.offset, out);
    resolvedByOid.set(oid, out);
    resolving.delete(entry.offset);
    return out;
  };
  return raw.map(resolve);
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): small, correct, fast to build. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array; oid?: string }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflatedFor(object.type, data, object.oid));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * The deflated bytes of an object, cached by oid: object data is immutable,
 * so the same object deflates to the same bytes on every pack that carries it.
 * The cache is bounded; when it fills it is dropped whole (a cold cache is
 * correct, never stale).
 */
const DEFLATED_CACHE = new Map<string, Buffer>();
const DEFLATED_CACHE_MAX = 8192;

function deflatedFor(type: GitObjectType, data: Buffer, oid: string | undefined): Buffer {
  const key = oid ?? hashObject(type, data);
  const cached = DEFLATED_CACHE.get(key);
  if (cached !== undefined) return cached;
  const deflated = deflateSync(data);
  if (DEFLATED_CACHE.size >= DEFLATED_CACHE_MAX) DEFLATED_CACHE.clear();
  DEFLATED_CACHE.set(key, deflated);
  return deflated;
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksumOk(pack: Uint8Array): boolean {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) return false;
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
  return actual === expected;
}

// ---------------------------------------------------------------------------------------------
// The store: repositories, issues, pull requests
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  /** Serialized REST JSON of this issue, or null when it must be rebuilt. */
  jsonCache: string | null;
}

/** Drop an issue's cached REST JSON after any mutation of the issue. */
export function invalidateIssueJson(issue: Issue): void {
  issue.jsonCache = null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
}

export class Repo {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  readonly nodeId: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  readonly pulls: PullRequest[] = [];
  nextNumber = 1;
  nextCommentId = 1;
  /** Sequence for server-invented commit timestamps (deterministic). */
  seq = 0;
  /**
   * Bumped whenever an object is stored: fetch selection depends only on the
   * object set, so this generation is the fetch cache's freshness key.
   */
  gen = 0;
  /** Bumped whenever a ref is set or deleted: the ls-refs / advertisement cache key. */
  refsGen = 0;
  /** O(1) lookup of issues and pulls by number (the arrays stay the order). */
  readonly issuesByNumber = new Map<number, Issue>();
  readonly pullsByNumber = new Map<number, PullRequest>();
  /**
   * Cached fetch responses (whole response Buffer), keyed by the fetch's
   * inputs plus `gen`. Bounded FIFO: the oldest entry goes when it fills.
   */
  readonly fetchCache = new Map<string, Buffer>();
  /** Cached ls-refs responses, keyed by refsGen + the ls-refs arguments. */
  readonly lsRefsCache = new Map<string, Buffer>();
  /** Cached v0 ref advertisements, keyed by service + refsGen. */
  readonly v0AdvCache = new Map<string, Buffer>();

  constructor(owner: string, name: string, id: number, description: string, isPrivate: boolean) {
    this.owner = owner;
    this.name = name;
    this.id = id;
    this.nodeId = Buffer.from(`forge:repo:${owner}/${name}`, 'utf8').toString('base64');
    this.description = description;
    this.isPrivate = isPrivate;
  }

  /** Store a ref (bumps refsGen; the ls-refs / advertisement caches key on it). */
  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
    this.refsGen += 1;
  }

  /** Delete a ref (bumps refsGen). */
  deleteRef(name: string): void {
    if (this.refs.delete(name)) this.refsGen += 1;
  }

  /** Store one object, bumping the object generation. Returns its id. */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.gen += 1;
    }
    return oid;
  }

  /** Store a whole unpacked pack's entries, bumping the generation once. */
  storePackEntries(entries: readonly { type: GitObjectType; data: Buffer; oid: string }[]): void {
    let added = false;
    for (const entry of entries) {
      if (!this.objects.has(entry.oid)) {
        this.objects.set(entry.oid, { type: entry.type, data: entry.data });
        added = true;
      }
    }
    if (added) this.gen += 1;
  }

  /** Add an issue, keeping the by-number index in step. */
  addIssue(issue: Issue): void {
    this.issues.push(issue);
    this.issuesByNumber.set(issue.number, issue);
  }

  /** Add a pull request, keeping the by-number index in step. */
  addPull(pull: PullRequest): void {
    this.pulls.push(pull);
    this.pullsByNumber.set(pull.number, pull);
  }

  findIssue(number: number): Issue | undefined {
    return this.issuesByNumber.get(number) ?? this.issues.find((entry) => entry.number === number);
  }

  findPull(number: number): PullRequest | undefined {
    return this.pullsByNumber.get(number) ?? this.pulls.find((entry) => entry.number === number);
  }

  /** Cache a fetch response, evicting the oldest entry when the cache fills. */
  cacheFetch(key: string, body: Buffer): void {
    if (this.fetchCache.size >= 64) {
      const oldest = this.fetchCache.keys().next();
      if (!oldest.done) this.fetchCache.delete(oldest.value);
    }
    this.fetchCache.set(key, body);
  }

  /** Cache an ls-refs response, evicting the oldest entry when it fills. */
  cacheLsRefs(key: string, body: Buffer): void {
    if (this.lsRefsCache.size >= 32) {
      const oldest = this.lsRefsCache.keys().next();
      if (!oldest.done) this.lsRefsCache.delete(oldest.value);
    }
    this.lsRefsCache.set(key, body);
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a ref name, a full ref, or a commit id to a commit id. */
  resolveRef(ref: string): string | undefined {
    if (isOid(ref) && this.objects.has(ref)) return ref;
    if (this.refs.has(ref)) return this.refs.get(ref);
    const branch = this.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = this.refs.get(`refs/tags/${ref}`);
    if (tag) {
      const object = this.objects.get(tag);
      if (object?.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    return undefined;
  }

  /** All files of a commit as path -> {oid, mode}, by walking its tree. */
  flatTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path -> blob-oid map; returns the root tree id. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create and store a commit object; returns its id. Timestamp is deterministic. */
  createCommit(treeOid: string, parents: readonly string[], message: string): string {
    this.seq += 1;
    const data = buildCommit({ tree: treeOid, parents, message, timestamp: FIXED_EPOCH + this.seq });
    return this.putObject('commit', data);
  }

  /**
   * Commit a set of file changes on a branch: `changes` maps path -> new bytes,
   * or null to delete the path. Returns the new commit id. The branch tip must
   * already be passed in (or null for an unborn branch).
   */
  commitFiles(branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    const tip = this.branchTip(branch);
    const files = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined) {
      const commit = parseCommit(this.objects.get(tip)!.data);
      for (const [path, entry] of this.flatTree(commit.tree)) files.set(path, entry);
    }
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { oid: this.putObject('blob', content), mode: '100644' });
    }
    const treeOid = this.buildTreeFromFiles(files);
    const parents = tip === undefined ? [] : [tip];
    const commitOid = this.createCommit(treeOid, parents, message);
    this.setRef(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** Commits reachable from a tip, newest first (first-parent walk order is breadth). */
  commitsFrom(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** The changed paths between two trees, with per-path before/after blob ids. */
  diffTrees(baseTreeOid: string | null, headTreeOid: string | null): Array<{
    path: string;
    status: 'added' | 'removed' | 'modified';
    baseOid: string | null;
    headOid: string | null;
  }> {
    const base = baseTreeOid === null ? new Map() : this.flatTree(baseTreeOid);
    const head = headTreeOid === null ? new Map() : this.flatTree(headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; baseOid: string | null; headOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', baseOid: b.oid, headOid: null });
      else if (!b && h) out.push({ path, status: 'added', baseOid: null, headOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', baseOid: b.oid, headOid: h.oid });
    }
    return out;
  }

  /**
   * Three-way squash merge of a pull request's head into its base. Returns the
   * new commit id, or null when the merge conflicts. The merged tree takes the
   * head's version of every path the head changed since the merge base, and the
   * base's version of everything else.
   */
  squashMerge(pull: PullRequest): string | null {
    const baseTip = this.branchTip(pull.baseRef);
    const headTip = this.branchTip(pull.headRef);
    if (baseTip === undefined || headTip === undefined) return null;
    const baseCommit = parseCommit(this.objects.get(baseTip)!.data);
    const headCommit = parseCommit(this.objects.get(headTip)!.data);
    const base = mergeBase(this.lookup, headTip, baseTip);
    const baseFiles = base === null ? new Map() : this.flatTree(parseCommit(this.objects.get(base)!.data).tree);
    const headFiles = this.flatTree(headCommit.tree);
    const baseTipFiles = this.flatTree(baseCommit.tree);
    const result = new Map<string, { oid: string; mode: string }>(baseTipFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const m = baseFiles.get(path);
      const h = headFiles.get(path);
      const b = baseTipFiles.get(path);
      const headChanged = (m?.oid ?? null) !== (h?.oid ?? null);
      const baseChanged = (m?.oid ?? null) !== (b?.oid ?? null);
      if (headChanged && baseChanged && (h?.oid ?? null) !== (b?.oid ?? null)) return null; // conflict
      if (headChanged) {
        if (h === undefined) result.delete(path);
        else result.set(path, h);
      }
    }
    const treeOid = this.buildTreeFromFiles(result);
    const message = `Merge pull request #${pull.number} from ${this.owner}/${pull.headRef}\n\n${pull.title}`;
    return this.createCommit(treeOid, [baseTip], message);
  }

  /** Whether a head branch merges cleanly into its base (no conflicting path). */
  isMergeable(headRef: string, baseRef: string): boolean {
    const baseTip = this.branchTip(baseRef);
    const headTip = this.branchTip(headRef);
    if (baseTip === undefined || headTip === undefined) return false;
    const base = mergeBase(this.lookup, headTip, baseTip);
    if (base === null) return true;
    const baseFiles = this.flatTree(parseCommit(this.objects.get(base)!.data).tree);
    const headFiles = this.flatTree(parseCommit(this.objects.get(headTip)!.data).tree);
    const baseTipFiles = this.flatTree(parseCommit(this.objects.get(baseTip)!.data).tree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const m = baseFiles.get(path);
      const h = headFiles.get(path);
      const b = baseTipFiles.get(path);
      if ((m?.oid ?? null) !== (h?.oid ?? null) && (m?.oid ?? null) !== (b?.oid ?? null) && (h?.oid ?? null) !== (b?.oid ?? null)) {
        return false;
      }
    }
    return true;
  }
}

export class Store {
  /** Repositories by name, all owned by the viewer. */
  readonly repos = new Map<string, Repo>();
  /** Insertion order, for GET /user/repos pagination. */
  readonly repoOrder: Repo[] = [];
  nextRepoId = 1;
  nextObjectId = 1;

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(VIEWER_LOGIN, name, this.nextRepoId++, description, isPrivate);
    this.repos.set(name, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (!repo) return false;
    this.repos.delete(name);
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  nextId(): number {
    return this.nextObjectId++;
  }

  static issueGlobalId(repo: Repo, issue: Issue): string {
    return Buffer.from(`forge:issue:${repo.fullName}:${issue.number}`, 'utf8').toString('base64');
  }

  static pullGlobalId(repo: Repo, pull: PullRequest): string {
    return Buffer.from(`forge:pr:${repo.fullName}:${pull.number}`, 'utf8').toString('base64');
  }

  static commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return Buffer.from(`forge:comment:${repo.fullName}:${issue.number}:${comment.id}`, 'utf8').toString('base64');
  }
}

/** Count added/removed lines between two blob contents (simple line-set diff). */
export function lineDiffCounts(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldContent === null ? [] : oldContent.toString('utf8').split('\n');
  const newLines = newContent === null ? [] : newContent.toString('utf8').split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  const newSet = new Map<string, number>();
  for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newSet) additions += Math.max(0, count - (oldSet.get(line) ?? 0));
  for (const [line, count] of oldSet) deletions += Math.max(0, count - (newSet.get(line) ?? 0));
  if (additions === 0 && deletions === 0 && (oldContent !== null || newContent !== null)) {
    // Same lines in a different order, or a changed file the set diff cannot see:
    // still report a change so the file is never 0/0.
    additions = 1;
  }
  return { additions, deletions };
}
