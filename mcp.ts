// mcp.ts — Model Context Protocol over Streamable HTTP at /mcp.
//
// The suite's client speaks two eras and this endpoint answers both from one
// code path:
//   - modern (2026-07-28): every request declares its revision and
//     `server/discover` returns supportedVersions + capabilities + serverInfo
//     in one result; there is no session and no GET stream.
//   - legacy (2025-11-25 and earlier): `initialize` (echoing a revision the
//     server supports) then `notifications/initialized`, with an optional
//     Mcp-Session-Id. This server is stateless, so it hands out no session id
//     and the legacy handshake still succeeds.
//
// Answers are plain application/json bodies (never SSE): the client accepts
// either. Every request answers inside the suite's 3 s budget — these tools
// are all in-memory store operations.
//
// tools/list is built once, as a constant: two calls answer the same list,
// byte for byte. Tools act on the same store as REST, so a repository or an
// issue created over MCP reads back over /api/v3 as the same object.

import { FIXED_ISO, Store, VIEWER_LOGIN, type Issue, type PullRequest, type Repo } from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'forge-mcp';
export const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const OWNER_PROP = { type: 'string', description: 'The repository owner login.' };
const REPO_PROP = { type: 'string', description: 'The repository name.' };

export const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
    owner: OWNER_PROP,
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { owner: OWNER_PROP, repo: REPO_PROP, full_name: { type: 'string', description: 'The repository full name, owner/repo.' } }, ['owner', 'repo']),
  tool('list_repos', 'List repositories owned by the authenticated user.', {
    per_page: { type: 'integer', description: 'Results per page.' },
    page: { type: 'integer', description: 'Page number.' },
  }, []),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
    labels: { type: 'array', description: 'Labels to attach; each must already exist.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue by number.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    number: { type: 'integer', description: 'The issue number.' },
    issue_number: { type: 'integer', description: 'The issue number.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo', 'number']),
  tool('list_issues', 'List issues of a repository, optionally filtered by state.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    state: { type: 'string', description: 'open, closed or all.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo']),
  tool('close_issue', 'Close an issue by number.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    number: { type: 'integer', description: 'The issue number.' },
    issue_number: { type: 'integer', description: 'The issue number.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo', 'number']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('get_pull_request', 'Get one pull request by number.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    number: { type: 'integer', description: 'The pull request number.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo', 'number']),
  tool('list_pull_requests', 'List pull requests of a repository.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    state: { type: 'string', description: 'open, closed or all.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Squash-merge a pull request by number.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    pull_number: { type: 'integer', description: 'The pull request number.' },
    number: { type: 'integer', description: 'The pull request number.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo', 'pull_number']),
  tool('add_comment', 'Add a comment to an issue.', {
    owner: OWNER_PROP, repo: REPO_PROP,
    number: { type: 'integer', description: 'The issue number.' },
    issue_number: { type: 'integer', description: 'The issue number.' },
    body: { type: 'string', description: 'The comment body.' },
    full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
  }, ['owner', 'repo', 'number', 'body']),
]);

// ---------------------------------------------------------------------------------------------
// Argument mapping: the suite maps each argument onto the schema's nearest
// property name and fills full_name with owner/repo, so resolve flexibly.
// ---------------------------------------------------------------------------------------------

type Args = Record<string, unknown>;

function pickString(args: Args, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickNumber(args: Args, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

function resolveOwnerRepo(args: Args): { owner: string; repo: string } | null {
  let owner = pickString(args, ['owner']);
  let repo = pickString(args, ['repo', 'repo_name', 'repository', 'repository_name', 'name']);
  const fullName = pickString(args, ['full_name', 'fullName']);
  if (fullName !== undefined && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    if (o !== '' && r !== '') {
      owner = owner ?? o;
      repo = repo ?? r;
    }
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------------------------
// JSON views shared with REST (same objects, same ids)
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN },
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

// ---------------------------------------------------------------------------------------------
// Tool execution. Returns {result} or {error} (a tool-level failure, isError).
// ---------------------------------------------------------------------------------------------

interface ToolOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function executeTool(store: Store, name: string, args: Args): ToolOutcome {
  const canonical = name.toLowerCase().replace(/^github__/, '');
  switch (canonical) {
    case 'create_repo': {
      const repoName = pickString(args, ['name', 'repo', 'repo_name', 'repository_name']);
      if (repoName === undefined) return { ok: false, error: 'Missing required argument: name' };
      const description = pickString(args, ['description']) ?? '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : true;
      const repo = store.createRepo(repoName, description, isPrivate);
      if (!repo) return { ok: false, error: `Repository ${repoName} already exists` };
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { ok: false, error: `Repository ${target.owner}/${target.repo} not found` };
      return { ok: true, value: repoJson(repo) };
    }
    case 'list_repos': {
      const perPage = pickNumber(args, ['per_page']) ?? 30;
      const page = pickNumber(args, ['page']) ?? 1;
      const start = (page - 1) * perPage;
      return { ok: true, value: store.repoOrder.slice(start, start + perPage).map(repoJson) };
    }
    case 'create_issue': {
      const target = resolveOwnerRepo(args);
      const title = pickString(args, ['title', 'issue_title']);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      if (title === undefined) return { ok: false, error: 'Missing required argument: title' };
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { ok: false, error: `Repository ${target.owner}/${target.repo} not found` };
      const body = pickString(args, ['body']) ?? '';
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return { ok: false, error: `Label "${label}" does not exist` };
      }
      const issue: Issue = { id: store.nextId(), number: repo.nextNumber++, title, body, state: 'open', labels, comments: [] };
      repo.issues.push(issue);
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'get_issue': {
      const target = resolveOwnerRepo(args);
      const number = pickNumber(args, ['number', 'issue_number']);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      if (number === undefined) return { ok: false, error: 'Missing required argument: number' };
      const repo = store.getRepo(target.owner, target.repo);
      const issue = repo?.issues.find((entry) => entry.number === number);
      if (!issue || !repo) return { ok: false, error: `Issue #${number} not found` };
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { ok: false, error: `Repository ${target.owner}/${target.repo} not found` };
      const state = pickString(args, ['state']) ?? 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { ok: true, value: issues.map((issue) => issueJson(repo, issue)) };
    }
    case 'close_issue': {
      const target = resolveOwnerRepo(args);
      const number = pickNumber(args, ['number', 'issue_number']);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      if (number === undefined) return { ok: false, error: 'Missing required argument: number' };
      const repo = store.getRepo(target.owner, target.repo);
      const issue = repo?.issues.find((entry) => entry.number === number);
      if (!issue || !repo) return { ok: false, error: `Issue #${number} not found` };
      issue.state = 'closed';
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'create_pull_request': {
      const target = resolveOwnerRepo(args);
      const title = pickString(args, ['title', 'pr_title']);
      const head = pickString(args, ['head', 'head_ref']);
      const base = pickString(args, ['base', 'base_ref']) ?? undefined;
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      if (title === undefined) return { ok: false, error: 'Missing required argument: title' };
      if (head === undefined) return { ok: false, error: 'Missing required argument: head' };
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { ok: false, error: `Repository ${target.owner}/${target.repo} not found` };
      const baseRef = base ?? repo.defaultBranch;
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined || baseSha === undefined) {
        return { ok: false, error: `Head or base branch not found: ${head} -> ${baseRef}` };
      }
      const body = pickString(args, ['body']) ?? '';
      const pull: PullRequest = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title,
        body,
        state: 'open',
        headRef: head,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeSha: null,
      };
      repo.pulls.push(pull);
      return { ok: true, value: pullJson(repo, pull) };
    }
    case 'get_pull_request': {
      const target = resolveOwnerRepo(args);
      const number = pickNumber(args, ['number', 'pull_number']);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      if (number === undefined) return { ok: false, error: 'Missing required argument: number' };
      const repo = store.getRepo(target.owner, target.repo);
      const pull = repo?.pulls.find((entry) => entry.number === number);
      if (!pull || !repo) return { ok: false, error: `Pull request #${number} not found` };
      return { ok: true, value: pullJson(repo, pull) };
    }
    case 'list_pull_requests': {
      const target = resolveOwnerRepo(args);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { ok: false, error: `Repository ${target.owner}/${target.repo} not found` };
      const state = pickString(args, ['state']) ?? 'open';
      const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return { ok: true, value: pulls.map((pull) => pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      const number = pickNumber(args, ['pull_number', 'number', 'pull_request_number']);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      if (number === undefined) return { ok: false, error: 'Missing required argument: pull_number' };
      const repo = store.getRepo(target.owner, target.repo);
      const pull = repo?.pulls.find((entry) => entry.number === number);
      if (!pull || !repo) return { ok: false, error: `Pull request #${number} not found` };
      if (pull.merged || pull.state !== 'open') return { ok: false, error: `Pull request #${number} is not open` };
      const mergeSha = repo.squashMerge(pull);
      if (mergeSha === null) return { ok: false, error: `Pull request #${number} has merge conflicts` };
      pull.merged = true;
      pull.mergedAt = FIXED_ISO;
      pull.mergeSha = mergeSha;
      pull.state = 'closed';
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      return { ok: true, value: { sha: mergeSha, merged: true, message: `Merged pull request #${number}` } };
    }
    case 'add_comment': {
      const target = resolveOwnerRepo(args);
      const number = pickNumber(args, ['number', 'issue_number']);
      const body = pickString(args, ['body']);
      if (!target) return { ok: false, error: 'Missing required arguments: owner, repo' };
      if (number === undefined) return { ok: false, error: 'Missing required argument: number' };
      if (body === undefined) return { ok: false, error: 'Missing required argument: body' };
      const repo = store.getRepo(target.owner, target.repo);
      const issue = repo?.issues.find((entry) => entry.number === number);
      if (!issue || !repo) return { ok: false, error: `Issue #${number} not found` };
      const comment = { id: repo.nextCommentId++, body };
      issue.comments.push(comment);
      return { ok: true, value: { id: comment.id, body } };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

/** Whether `name` is a tool this server offers (suffix- and case-insensitive). */
export function findTool(name: string): ToolDef | undefined {
  const wanted = name.toLowerCase().replace(/^github__/, '');
  return TOOLS.find((toolDef) => toolDef.name.toLowerCase() === wanted);
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch. Returns {status, body} for the app layer to send.
// ---------------------------------------------------------------------------------------------

export interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

export function handleMcpRequest(store: Store, request: RpcRequest): { status: number; body: unknown } {
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') {
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request: method must be a string') };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [...MCP_SUPPORTED_REVISIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    const negotiated = MCP_SUPPORTED_REVISIONS.includes(offered) ? offered : MCP_REVISION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification carries no id and expects no result; 202, empty body.
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Args;
    const toolDef = toolName === '' ? undefined : findTool(toolName);
    if (!toolDef) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: tool "${toolName}"`) };
    }
    // A missing required argument is a tool-level error (isError), which the
    // suite accepts alongside JSON-RPC -32602.
    const outcome = executeTool(store, toolDef.name, args);
    if (!outcome.ok) {
      return { status: 200, body: rpcResult(id, toolError(outcome.error ?? 'Tool failed')) };
    }
    return { status: 200, body: rpcResult(id, toolResult(outcome.value)) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
