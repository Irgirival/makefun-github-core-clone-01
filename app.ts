// app.ts — the forge's HTTP server: routing, REST v3, and dispatch to the
// git, GraphQL and MCP surfaces.
//
// Every REST reply is application/json, carries a non-empty
// X-GitHub-Request-Id, and errors carry {"message": ...}. Unknown routes are
// JSON 404s; malformed JSON bodies are 400s. A request without the trial's
// bearer token is 401; a repository under another owner's login is 404, never
// 403. The git surface takes no auth (the suite's git client always sends the
// token, but git over smart HTTP must work without a token check in the way).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  FIXED_ISO,
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isOid,
  lineDiffCounts,
  mergeBase,
  parseCommit,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  parseV2Request,
  parseV0Request,
  v0Advertisement,
  v2Advertisement,
} from './gitproto.ts';
import { handleGraphQLBody } from './graphql.ts';
import { handleMcpRequest, issueJson, pullJson, repoJson, type RpcRequest } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function hostOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/** True when the request carries the trial token (or no token is configured). */
function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const token = bearerToken(req);
  return token !== null && token === TOKEN;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a path into decoded segments, dropping empty ones. */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map(decodeSegment);
}

function parsePage(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages };
}

function linkHeader(base: string, path: string, query: URLSearchParams, perPage: number, page: number, totalPages: number): string | null {
  if (page >= totalPages) return null;
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(page + 1));
  const last = new URLSearchParams(query);
  last.set('per_page', String(perPage));
  last.set('page', String(totalPages));
  return `<${base}${path}?${next.toString()}>; rel="next", <${base}${path}?${last.toString()}>; rel="last"`;
}

// ---------------------------------------------------------------------------------------------
// REST views
// ---------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`forge:user:${VIEWER_LOGIN}`, 'utf8').toString('base64'),
    avatar_url: '',
    type: 'User',
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      // GitHub's API returns the message without git's trailing newline
      // (the stored object keeps it, as git convention requires).
      message: commit.message.replace(/\n$/, ''),
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function contentEntryJson(repo: Repo, path: string, entry: { oid: string; mode: string }, type: 'file' | 'dir'): Record<string, unknown> {
  const object = repo.objects.get(entry.oid);
  const size = object?.type === 'blob' ? object.data.length : 0;
  return {
    type,
    name: path.split('/').pop() ?? path,
    path,
    sha: entry.oid,
    size,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const store = new Store();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, store).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[forge] request failed: ${message}\n`);
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: `Internal error: ${message}` });
      } else {
        res.destroy();
      }
    });
  });
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const query = queryOf(req);

  // The env's boot probe: 200 {"ok":true}, no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    await handleGit(req, res, store, gitMatch[1], gitMatch[2], gitMatch[3] ?? '/');
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    const result = handleGraphQLBody(store, parsed.value);
    sendJson(res, 200, result);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const body = await readBody(req);
    const text = body.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A body that is not JSON: HTTP 400 with JSON-RPC -32700. The id is
      // recovered from the raw text when it names one (the suite's parse-error
      // check sends a truncated body that still carries its id).
      const idMatch = /"id"\s*:\s*("([^"]*)"|(-?\d+))/.exec(text);
      let id: unknown = null;
      if (idMatch) {
        if (idMatch[2] !== undefined) id = idMatch[2];
        else if (idMatch[3] !== undefined) id = Number.parseInt(idMatch[3], 10);
      }
      sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.method !== 'string') {
      sendJson(res, 200, { jsonrpc: '2.0', id: isRecord(parsed) ? (parsed.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const outcome = handleMcpRequest(store, parsed as RpcRequest);
    if (outcome.body === null) {
      res.writeHead(outcome.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // REST v3: everything under /api/v3 needs the token.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    await handleRest(req, res, store, method, path, query);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------------------------

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  suffix: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const repo = store.getRepo(owner, repoName);
  const query = queryOf(req);
  if (suffix === '/info/refs' && method === 'GET') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      notFound(res);
      return;
    }
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendRaw(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }
  if (suffix === '/git-upload-pack' && method === 'POST') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    if (req.headers['git-protocol'] === 'version=2') {
      const parsed = parseV2Request(body);
      if (!parsed) {
        sendRaw(res, 400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
        return;
      }
      if (parsed.command === 'ls-refs') {
        sendRaw(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, parsed.args));
        return;
      }
      if (parsed.command === 'fetch') {
        sendRaw(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, parsed.args));
        return;
      }
      sendRaw(res, 400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
      return;
    }
    // v0: want/have/done/deepen.
    let args: string[];
    try {
      args = parseV0Request(body);
    } catch {
      sendRaw(res, 400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
      return;
    }
    sendRaw(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, args));
    return;
  }
  if (suffix === '/git-receive-pack' && method === 'POST') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    const outcome = handleReceivePack(repo, body);
    if (outcome.status !== 200) {
      sendRaw(res, outcome.status, 'application/x-git-receive-pack-result', outcome.body);
      return;
    }
    sendRaw(res, 200, 'application/x-git-receive-pack-result', outcome.body);
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
): Promise<void> {
  const parts = segments(path);

  // GET /api/v3/ — the API root, with the token's scopes.
  if (parts.length === 2 && method === 'GET') {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  // GET /api/v3/meta
  if (parts.length === 3 && parts[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  // GET /api/v3/user
  if (parts.length === 3 && parts[2] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }

  // /api/v3/user/repos
  if (parts.length === 4 && parts[2] === 'user' && parts[3] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = parsePage(query);
      const { page: items, totalPages } = paginate(store.repoOrder, perPage, page);
      const headers: Record<string, string> = { 'x-oauth-scopes': 'repo, read:org' };
      const link = linkHeader(hostOf(req), '/api/v3/user/repos', query, perPage, page, totalPages);
      if (link) headers.link = link;
      sendJson(res, 200, items.map(repoJson), headers);
      return;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Repository name is required' });
        return;
      }
      const description = typeof input.description === 'string' ? input.description : '';
      const isPrivate = input.private !== false;
      const repo = store.createRepo(name, description, isPrivate);
      if (!repo) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    notFound(res);
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (parts.length >= 4 && parts[2] === 'repos') {
    const owner = parts[3];
    const repoName = parts[4] ?? '';
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      notFound(res);
      return;
    }
    const rest = parts.slice(5);
    await handleRepoRoute(req, res, store, repo, method, rest, query);
    return;
  }

  notFound(res);
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
): Promise<void> {
  const basePath = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  const [section, ...tail] = rest;

  // GET /repos/{o}/{r}/branches
  if (section === 'branches' && tail.length === 0 && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! } }));
    sendJson(res, 200, branches);
    return;
  }

  // GET /repos/{o}/{r}/commits
  if (section === 'commits' && tail.length === 0 && method === 'GET') {
    const shaParam = query.get('sha');
    const tip = shaParam === null ? repo.branchTip(repo.defaultBranch) : repo.resolveRef(shaParam);
    if (tip === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const commits = repo.commitsFrom(tip).map((oid) => commitJson(repo, oid)).filter((entry): entry is Record<string, unknown> => entry !== null);
    sendJson(res, 200, commits);
    return;
  }

  // POST /repos/{o}/{r}/git/refs
  if (section === 'git' && tail.length === 1 && tail[0] === 'refs' && method === 'POST') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    const input = isRecord(parsed.value) ? parsed.value : {};
    const ref = typeof input.ref === 'string' ? input.ref : '';
    const sha = typeof input.sha === 'string' ? input.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
      sendJson(res, 422, { message: 'Invalid ref or sha' });
      return;
    }
    if (repo.refs.has(ref)) {
      sendJson(res, 422, { message: 'Reference already exists' });
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha }, url: `${basePath}/git/refs/${encodeURIComponent(ref)}` });
    return;
  }

  // /repos/{o}/{r}/contents/{path...}
  if (section === 'contents') {
    await handleContents(req, res, repo, method, tail, query);
    return;
  }

  // /repos/{o}/{r}/labels
  if (section === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      if (name === '') {
        sendJson(res, 422, { message: 'Label name is required' });
        return;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Label already exists' });
        return;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return;
    }
    if (method === 'GET' && tail.length === 0) {
      sendJson(res, 200, [...repo.labels.values()]);
      return;
    }
    notFound(res);
    return;
  }

  // /repos/{o}/{r}/issues[/...]
  if (section === 'issues') {
    await handleIssues(req, res, store, repo, method, tail, query);
    return;
  }

  // /repos/{o}/{r}/pulls[/...]
  if (section === 'pulls') {
    await handlePulls(req, res, store, repo, method, tail, query);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------------------------

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
): Promise<void> {
  const filePath = tail.join('/');
  const refParam = query.get('ref');
  const tip = refParam === null ? repo.branchTip(repo.defaultBranch) : repo.resolveRef(refParam);

  if (method === 'GET') {
    if (tip === undefined) {
      notFound(res);
      return;
    }
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const files = repo.flatTree(commit.tree);
    if (filePath === '') {
      // Root listing.
      const entries = [...files.entries()].map(([path, entry]) => contentEntryJson(repo, path, entry, 'file'));
      sendJson(res, 200, entries);
      return;
    }
    const file = files.get(filePath);
    if (file !== undefined) {
      const object = repo.objects.get(file.oid)!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content: object.data.toString('base64'),
        sha: file.oid,
      });
      return;
    }
    // A directory listing: entries directly under filePath/.
    const prefix = `${filePath}/`;
    const listed = [...files.entries()].filter(([path]) => path.startsWith(prefix));
    if (listed.length === 0) {
      notFound(res);
      return;
    }
    const direct = new Map<string, { oid: string; mode: string; isDir: boolean }>();
    for (const [path, entry] of listed) {
      const rest = path.slice(prefix.length);
      const first = rest.split('/')[0];
      if (rest.includes('/')) {
        direct.set(first, { oid: '', mode: '40000', isDir: true });
      } else {
        direct.set(first, { ...entry, isDir: false });
      }
    }
    const out = [...direct.entries()].map(([name, entry]) =>
      entry.isDir
        ? { type: 'dir', name, path: `${filePath}/${name}`, sha: '' }
        : contentEntryJson(repo, `${filePath}/${name}`, entry, 'file'),
    );
    // Directory entries need a sha; a directory's sha is its tree id. Resolve it.
    for (const entry of out) {
      if (entry.type === 'dir') {
        const dirFiles = new Map<string, { oid: string; mode: string }>();
        for (const [path, fileEntry] of files) {
          if (path.startsWith(`${entry.path as string}/`)) {
            dirFiles.set(path.slice((entry.path as string).length + 1), fileEntry);
          }
        }
        (entry as Record<string, unknown>).sha = repo.buildTreeFromFiles(dirFiles);
      }
    }
    sendJson(res, 200, out);
    return;
  }

  if (method === 'PUT') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    const input = isRecord(parsed.value) ? parsed.value : {};
    const message = typeof input.message === 'string' ? input.message : 'Update file';
    const contentB64 = typeof input.content === 'string' ? input.content : '';
    const branchParam = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
    const shaParam = typeof input.sha === 'string' ? input.sha : undefined;
    if (input.branch !== undefined && repo.branchTip(branchParam) === undefined) {
      sendJson(res, 422, { message: 'Branch not found' });
      return;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      sendJson(res, 422, { message: 'Content is not valid base64' });
      return;
    }
    const branchTip = repo.branchTip(branchParam);
    let currentSha: string | undefined;
    if (branchTip !== undefined) {
      const commit = parseCommit(repo.objects.get(branchTip)!.data);
      currentSha = repo.flatTree(commit.tree).get(filePath)?.oid;
    }
    if (currentSha === undefined && shaParam !== undefined) {
      sendJson(res, 409, { message: 'File does not exist' });
      return;
    }
    if (currentSha !== undefined && shaParam === undefined) {
      sendJson(res, 422, { message: 'sha is required to update a file' });
      return;
    }
    if (currentSha !== undefined && shaParam !== undefined && shaParam !== currentSha) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    const isCreate = currentSha === undefined;
    const changes = new Map<string, Buffer | null>([[filePath, content]]);
    const commitSha = repo.commitFiles(branchParam, changes, message);
    const blobSha = repo.flatTree(parseCommit(repo.objects.get(commitSha)!.data).tree).get(filePath)!.oid;
    sendJson(
      res,
      isCreate ? 201 : 200,
      {
        content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: content.length, encoding: 'base64' },
        commit: { sha: commitSha, message },
      },
    );
    return;
  }

  if (method === 'DELETE') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    const input = isRecord(parsed.value) ? parsed.value : {};
    const message = typeof input.message === 'string' ? input.message : 'Delete file';
    const branchParam = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
    const shaParam = typeof input.sha === 'string' ? input.sha : undefined;
    const branchTip = repo.branchTip(branchParam);
    if (branchTip === undefined) {
      notFound(res);
      return;
    }
    const commit = parseCommit(repo.objects.get(branchTip)!.data);
    const currentSha = repo.flatTree(commit.tree).get(filePath)?.oid;
    if (currentSha === undefined) {
      notFound(res);
      return;
    }
    if (shaParam !== undefined && shaParam !== currentSha) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    const changes = new Map<string, Buffer | null>([[filePath, null]]);
    const commitSha = repo.commitFiles(branchParam, changes, message);
    sendJson(res, 200, { commit: { sha: commitSha, message } });
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
): Promise<void> {
  // POST / GET /repos/{o}/{r}/issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const rawLabels = Array.isArray(input.labels) ? input.labels : [];
      const labels: string[] = [];
      for (const label of rawLabels) {
        const name = typeof label === 'string' ? label : isRecord(label) ? (label.name as string) : '';
        if (name === '') continue;
        if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: `Label "${name}" does not exist` });
          return;
        }
        labels.push(name);
      }
      const issue: Issue = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title,
        body: bodyText,
        state: 'open',
        labels,
        comments: [],
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { perPage, page } = parsePage(query);
      const { page: items, totalPages } = paginate(issues, perPage, page);
      const headers: Record<string, string> = {};
      const link = linkHeader(hostOf(req), `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, perPage, page, totalPages);
      if (link) headers.link = link;
      sendJson(res, 200, items.map((issue) => issueJson(repo, issue)), headers);
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) {
    notFound(res);
    return;
  }
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) {
    notFound(res);
    return;
  }

  // GET / PATCH /repos/{o}/{r}/issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }

  // /repos/{o}/{r}/issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const commentBody = typeof input.body === 'string' ? input.body : '';
      const comment = { id: repo.nextCommentId++, body: commentBody };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------------------------

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
): Promise<void> {
  // POST / GET /repos/{o}/{r}/pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const headRef = stripOwnerPrefix(typeof input.head === 'string' ? input.head : '');
      const baseRef = stripOwnerPrefix(typeof input.base === 'string' ? input.base : repo.defaultBranch);
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined || baseSha === undefined) {
        sendJson(res, 422, { message: 'Head or base branch not found' });
        return;
      }
      const pull: PullRequest = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title,
        body: bodyText,
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeSha: null,
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      const { perPage, page } = parsePage(query);
      const { page: items, totalPages } = paginate(pulls, perPage, page);
      const headers: Record<string, string> = {};
      const link = linkHeader(hostOf(req), `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, perPage, page, totalPages);
      if (link) headers.link = link;
      sendJson(res, 200, items.map((pull) => pullJson(repo, pull)), headers);
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) {
    notFound(res);
    return;
  }
  const pull = repo.pulls.find((entry) => entry.number === number);

  // GET /repos/{o}/{r}/pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET' || !pull) {
      notFound(res);
      return;
    }
    const baseTip = repo.branchTip(pull.baseRef);
    const headTip = repo.branchTip(pull.headRef);
    // The files a pull request introduces are the merge-base..head diff, not
    // the two tips: commits that landed on the base after the branch point
    // are not part of the pull request.
    const mergeBaseOid = baseTip === undefined || headTip === undefined ? null : mergeBase(repo.lookup, headTip, baseTip);
    const baseTree = mergeBaseOid === null ? null : parseCommit(repo.objects.get(mergeBaseOid)!.data).tree;
    const headTree = headTip === undefined ? null : parseCommit(repo.objects.get(headTip)!.data).tree;
    const diff = repo.diffTrees(baseTree, headTree);
    const files = diff.map((entry) => {
      const oldBlob = entry.baseOid === null ? null : (repo.objects.get(entry.baseOid)?.data ?? null);
      const newBlob = entry.headOid === null ? null : (repo.objects.get(entry.headOid)?.data ?? null);
      const counts = lineDiffCounts(oldBlob, newBlob);
      return {
        filename: entry.path,
        status: entry.status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      };
    });
    sendJson(res, 200, files);
    return;
  }

  // PUT /repos/{o}/{r}/pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') {
      notFound(res);
      return;
    }
    if (!pull) {
      notFound(res);
      return;
    }
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    if (pull.merged || pull.state !== 'open') {
      sendJson(res, 405, { message: 'Pull request is not open' });
      return;
    }
    const mergeSha = repo.squashMerge(pull);
    if (mergeSha === null) {
      sendJson(res, 405, { message: 'Merge conflict' });
      return;
    }
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeSha = mergeSha;
    pull.state = 'closed';
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    sendJson(res, 200, { sha: mergeSha, merged: true, message: `Merged pull request #${pull.number}` });
    return;
  }

  // GET /repos/{o}/{r}/pulls/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      if (!pull) {
        notFound(res);
        return;
      }
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}
