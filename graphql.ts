// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
//
// A small hand-rolled executor: a tokenizer + recursive-descent parser for the
// GraphQL subset the suite sends (operations, variables, arguments, aliases,
// inline fragments), then resolvers over the same store REST uses, so a
// repository, issue or pull request created over GraphQL reads back over REST
// with the same ids.
//
// Behaviour the suite pins down:
//   - __type introspection for Issue / PullRequest / Repository / SearchType
//   - repository.issues with orderBy CREATED_AT DESC and states: [OPEN]
//   - createIssue / closeIssue / createPullRequest / mergePullRequest / addComment
//   - node(id:) round-trips a repository's opaque global id
//   - two operation documents in one HTTP body answer two results, in order
//   - an unknown field is HTTP 200 with an errors array naming it
//   - an unknown repository is data.repository = null with no errors
//   - global ids are opaque (base64 of a namespaced identity) and stable

import {
  FIXED_ISO,
  Store,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isOid,
  lineDiffCounts,
  parseCommit,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      if (/[.eE]/.test(text)) tokens.push({ kind: 'float', value: Number.parseFloat(text) });
      else tokens.push({ kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser: operations with selection trees, arguments as values or $variables.
// ---------------------------------------------------------------------------------------------

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selection: GqlField[] | null;
  /** Inline fragment type condition (`... on Repository { ... }`). */
  fragmentOn: string | null;
}

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: GqlField[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document`);
    }
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a directive name');
      if (this.isPunct('(')) this.parseArgs();
    }
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      type = token.value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') {
        name = next.value;
        this.next();
      }
    }
    const variables: string[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const dollar = this.next();
        if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in variable definition');
        const varName = this.next();
        if (varName.kind !== 'name') throw new Error('expected a variable name');
        variables.push(varName.value);
        this.expectPunct(':');
        // The variable's type: a name, possibly wrapped in [] and !.
        while (!this.isPunct(')') && !this.isPunct(',')) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === ',') break;
          if (t.kind === 'punct' && t.value === ')') {
            this.pos -= 1;
            break;
          }
        }
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { type, name, selection, variables };
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.isPunct('}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      if (this.peek()?.kind === 'spread') {
        this.next();
        let fragmentOn: string | null = null;
        const on = this.peek();
        if (on?.kind === 'name' && on.value === 'on') {
          this.next();
          const typeName = this.next();
          if (typeName.kind !== 'name') throw new Error('expected a type name after ... on');
          fragmentOn = typeName.value;
        }
        this.skipDirectives();
        const inner = this.parseSelectionSet();
        for (const field of inner) fields.push({ ...field, fragmentOn: fragmentOn ?? field.fragmentOn });
        continue;
      }
      const first = this.next();
      if (first.kind !== 'name') throw new Error('expected a field name');
      let alias: string | null = null;
      let name = first.value;
      if (this.isPunct(':')) {
        this.next();
        const real = this.next();
        if (real.kind !== 'name') throw new Error('expected a field name after an alias');
        alias = name;
        name = real.value;
      }
      const args = this.isPunct('(') ? this.parseArgs() : [];
      this.skipDirectives();
      const selection = this.isPunct('{') ? this.parseSelectionSet() : null;
      fields.push({ alias, name, args, selection, fragmentOn: null });
    }
    this.expectPunct('}');
    return fields;
  }

  private parseArgs(): Array<{ name: string; value: GqlValue }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: GqlValue }> = [];
    while (!this.isPunct(')')) {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args.push({ name: name.value, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a variable name');
      return { kind: 'var', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.isPunct('}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        fields.push({ name: name.value, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

/** Resolve a parsed value against the operation's variables to a plain JSON value. */
export function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

// ---------------------------------------------------------------------------------------------
// Introspection data
// ---------------------------------------------------------------------------------------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'author', 'url'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'];
const VIEWER_FIELDS = ['login', 'id', 'name', 'avatarUrl', 'url'];

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function unknownField(ctx: ExecContext, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function executeFields(ctx: ExecContext, typeName: string, object: unknown, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.fragmentOn !== null && !fragmentMatches(typeName, field.fragmentOn)) continue;
    out[key] = executeField(ctx, typeName, object, field);
  }
  return out;
}

function fragmentMatches(typeName: string, fragmentOn: string): boolean {
  return typeName === fragmentOn;
}

function executeField(ctx: ExecContext, typeName: string, object: unknown, field: GqlField): unknown {
  const selection = field.selection ?? [];
  switch (typeName) {
    case 'Query':
      return executeQueryField(ctx, field);
    case 'Repository':
      return executeRepositoryField(ctx, object as Repo, field, selection);
    case 'Issue':
      return executeIssueField(ctx, object as { repo: Repo; issue: Issue }, field, selection);
    case 'PullRequest':
      return executePullRequestField(ctx, object as { repo: Repo; pull: PullRequest }, field, selection);
    case 'User':
      return executeUserField(ctx, field);
    case 'Ref':
      return executeRefField(ctx, object as { name: string }, field);
    case 'IssueConnection':
      return executeIssueConnectionField(ctx, object as { repo: Repo; issues: Issue[] }, field, selection);
    case 'PullRequestConnection':
      return executePullRequestConnectionField(ctx, object as { repo: Repo; pulls: PullRequest[] }, field, selection);
    case 'PullRequestFileConnection':
      return executeFileConnectionField(ctx, object as { repo: Repo; pull: PullRequest }, field, selection);
    case 'PageInfo':
      return executePageInfoField(ctx, object as { hasNextPage: boolean; endCursor: string | null }, field);
    case '__Type':
      return executeTypeField(ctx, object as string, field, selection);
    case 'CommentEdge':
      return executeCommentEdgeField(ctx, object as { repo: Repo; issue: Issue; comment: { id: number; body: string } }, field, selection);
    case 'Comment':
      return executeCommentField(ctx, object as { id: number; body: string }, field);
    case 'Mutation':
      return executeMutationField(ctx, field);
    default:
      return unknownField(ctx, typeName, field.name);
  }
}

function executeQueryField(ctx: ExecContext, field: GqlField): unknown {
  const selection = field.selection ?? [];
  switch (field.name) {
    case 'viewer': {
      return executeFields(ctx, 'User', null, selection);
    }
    case 'repository': {
      const owner = argValue(field, 'owner', ctx.variables);
      const name = argValue(field, 'name', ctx.variables);
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) return null;
      return executeFields(ctx, 'Repository', repo, selection);
    }
    case 'node': {
      const id = argValue(field, 'id', ctx.variables);
      if (typeof id !== 'string') return null;
      const node = resolveGlobalId(ctx.store, id);
      if (!node) return null;
      return executeFields(ctx, node.type, node.value, selection);
    }
    case '__type': {
      const name = argValue(field, 'name', ctx.variables);
      if (typeof name !== 'string') return null;
      return executeFields(ctx, '__Type', name, selection);
    }
    case '__schema':
      return executeFields(ctx, '__Schema', null, selection);
    default:
      return unknownField(ctx, 'Query', field.name);
  }
}

function executeRepositoryField(ctx: ExecContext, repo: Repo, field: GqlField, selection: GqlField[]): unknown {
  switch (field.name) {
    case 'id':
      return repo.nodeId;
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repo.fullName;
    case 'owner':
      return executeFields(ctx, 'User', null, selection);
    case 'defaultBranchRef': {
      const tip = repo.branchTip(repo.defaultBranch);
      if (tip === undefined) return null;
      return executeFields(ctx, 'Ref', { name: repo.defaultBranch }, selection);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'url':
      return `/${repo.fullName}`;
    case 'createdAt':
    case 'updatedAt':
      return FIXED_ISO;
    case 'issue': {
      const number = argValue(field, 'number', ctx.variables);
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      if (!issue) return null;
      return executeFields(ctx, 'Issue', { repo, issue }, selection);
    }
    case 'issues': {
      // The connection keeps the full filtered list; `first` slices the nodes
      // while pageInfo is computed from what remains (see IssueConnection).
      const issues = filterIssues(ctx, repo, field);
      const first = argValue(field, 'first', ctx.variables);
      const page = { repo, issues, first: typeof first === 'number' ? first : undefined };
      return executeFields(ctx, 'IssueConnection', page, selection);
    }
    case 'pullRequests': {
      const first = argValue(field, 'first', ctx.variables);
      const pulls = [...repo.pulls];
      const limited = typeof first === 'number' ? pulls.slice(0, first) : pulls;
      return executeFields(ctx, 'PullRequestConnection', { repo, pulls: limited }, selection);
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', ctx.variables);
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return null;
      return executeFields(ctx, 'PullRequest', { repo, pull }, selection);
    }
    default:
      return unknownField(ctx, 'Repository', field.name);
  }
}

/** Apply states/orderBy/after to a repository's issues for a connection. `first`
 * is NOT applied here: the connection slices the nodes and computes pageInfo
 * from the remainder. */
function filterIssues(ctx: ExecContext, repo: Repo, field: GqlField): Issue[] {
  let issues = [...repo.issues];
  const states = argValue(field, 'states', ctx.variables);
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = argValue(field, 'orderBy', ctx.variables);
  let direction: 'ASC' | 'DESC' = 'DESC';
  if (isRecord(orderBy) && typeof orderBy.direction === 'string') {
    direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const after = decodeCursor(argValue(field, 'after', ctx.variables));
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'DESC' ? issue.number < after : issue.number > after));
  }
  return issues;
}

function executeIssueField(ctx: ExecContext, value: { repo: Repo; issue: Issue }, field: GqlField, selection: GqlField[]): unknown {
  const { repo, issue } = value;
  switch (field.name) {
    case 'id':
      return Store.issueGlobalId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issueState(issue);
    case 'body':
      return issue.body;
    case 'createdAt':
    case 'updatedAt':
      return FIXED_ISO;
    case 'author':
      return executeFields(ctx, 'User', null, selection);
    case 'url':
      return `/${repo.fullName}/issues/${issue.number}`;
    case 'labels':
      return issue.labels.map((name) => ({ name }));
    case 'comments':
      return issue.comments.map((comment) => ({ id: comment.id, body: comment.body }));
    case 'repository':
      return executeFields(ctx, 'Repository', repo, selection);
    default:
      return unknownField(ctx, 'Issue', field.name);
  }
}

function executePullRequestField(ctx: ExecContext, value: { repo: Repo; pull: PullRequest }, field: GqlField, selection: GqlField[]): unknown {
  const { repo, pull } = value;
  switch (field.name) {
    case 'id':
      return Store.pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullState(pull);
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRef':
      return executeFields(ctx, 'Ref', { name: pull.headRef }, selection);
    case 'baseRef':
      return executeFields(ctx, 'Ref', { name: pull.baseRef }, selection);
    case 'mergeable':
      return repo.isMergeable(pull.headRef, pull.baseRef) ? 'MERGEABLE' : 'CONFLICTING';
    case 'merged':
      return pull.merged;
    case 'mergeCommit':
      return pull.mergeSha === null ? null : { oid: pull.mergeSha };
    case 'files':
      return executeFields(ctx, 'PullRequestFileConnection', { repo, pull }, selection);
    case 'createdAt':
    case 'updatedAt':
      return FIXED_ISO;
    case 'author':
      return executeFields(ctx, 'User', null, selection);
    case 'url':
      return `/${repo.fullName}/pull/${pull.number}`;
    default:
      return unknownField(ctx, 'PullRequest', field.name);
  }
}

function executeUserField(ctx: ExecContext, field: GqlField): unknown {
  switch (field.name) {
    case 'login':
      return VIEWER_LOGIN;
    case 'id':
      return Buffer.from(`forge:user:${VIEWER_LOGIN}`, 'utf8').toString('base64');
    case 'name':
      return VIEWER_NAME;
    case 'avatarUrl':
      return '';
    case 'url':
      return `/${VIEWER_LOGIN}`;
    default:
      return unknownField(ctx, 'User', field.name);
  }
}

function executeRefField(ctx: ExecContext, value: { name: string }, field: GqlField): unknown {
  switch (field.name) {
    case 'name':
      return value.name;
    case 'target':
      return null;
    default:
      return unknownField(ctx, 'Ref', field.name);
  }
}

function executeIssueConnectionField(ctx: ExecContext, value: { repo: Repo; issues: Issue[]; first?: number }, field: GqlField, selection: GqlField[]): unknown {
  const { repo, issues, first } = value;
  const page = first === undefined ? issues : issues.slice(0, first);
  const hasNextPage = first !== undefined && issues.length > first;
  switch (field.name) {
    case 'nodes':
      return page.map((issue) => executeFields(ctx, 'Issue', { repo, issue }, selection));
    case 'edges':
      return page.map((issue) => ({ node: executeFields(ctx, 'Issue', { repo, issue }, selection), cursor: encodeCursor(issue.number) }));
    case 'totalCount':
      return issues.length;
    case 'pageInfo': {
      const last = page[page.length - 1];
      return executeFields(ctx, 'PageInfo', { hasNextPage, endCursor: last === undefined ? null : encodeCursor(last.number) }, selection);
    }
    default:
      return unknownField(ctx, 'IssueConnection', field.name);
  }
}

function executePullRequestConnectionField(ctx: ExecContext, value: { repo: Repo; pulls: PullRequest[] }, field: GqlField, selection: GqlField[]): unknown {
  const { repo, pulls } = value;
  switch (field.name) {
    case 'nodes':
      return pulls.map((pull) => executeFields(ctx, 'PullRequest', { repo, pull }, selection));
    case 'edges':
      return pulls.map((pull) => ({ node: executeFields(ctx, 'PullRequest', { repo, pull }, selection), cursor: encodeCursor(pull.number) }));
    case 'totalCount':
      return pulls.length;
    case 'pageInfo':
      return executeFields(ctx, 'PageInfo', { hasNextPage: false, endCursor: null }, selection);
    default:
      return unknownField(ctx, 'PullRequestConnection', field.name);
  }
}

function executeFileConnectionField(ctx: ExecContext, value: { repo: Repo; pull: PullRequest }, field: GqlField, selection: GqlField[]): unknown {
  const { repo, pull } = value;
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  const baseTree = baseTip === undefined ? null : parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTree = headTip === undefined ? null : parseCommit(repo.objects.get(headTip)!.data).tree;
  const diff = repo.diffTrees(baseTree, headTree);
  const first = argValue(field, 'first', ctx.variables);
  const limited = typeof first === 'number' ? diff.slice(0, first) : diff;
  switch (field.name) {
    case 'nodes':
      return limited.map((entry) => {
        const out: Record<string, unknown> = {};
        for (const sub of selection) {
          if (sub.name === 'path') out[sub.alias ?? sub.name] = entry.path;
          else if (sub.name === 'additions' || sub.name === 'deletions' || sub.name === 'changeType') {
            const oldBlob = entry.baseOid === null ? null : repo.objects.get(entry.baseOid)?.data ?? null;
            const newBlob = entry.headOid === null ? null : repo.objects.get(entry.headOid)?.data ?? null;
            const counts = lineDiffCounts(oldBlob, newBlob);
            if (sub.name === 'additions') out[sub.alias ?? sub.name] = counts.additions;
            else if (sub.name === 'deletions') out[sub.alias ?? sub.name] = counts.deletions;
            else out[sub.alias ?? sub.name] = entry.status.toUpperCase();
          } else {
            ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "PullRequestFile".` });
            out[sub.alias ?? sub.name] = null;
          }
        }
        return out;
      });
    case 'totalCount':
      return diff.length;
    case 'pageInfo':
      return executeFields(ctx, 'PageInfo', { hasNextPage: false, endCursor: null }, selection);
    default:
      return unknownField(ctx, 'PullRequestFileConnection', field.name);
  }
}

function executePageInfoField(ctx: ExecContext, value: { hasNextPage: boolean; endCursor: string | null }, field: GqlField): unknown {
  switch (field.name) {
    case 'hasNextPage':
      return value.hasNextPage;
    case 'hasPreviousPage':
      return false;
    case 'endCursor':
      return value.endCursor;
    case 'startCursor':
      return value.endCursor;
    default:
      return unknownField(ctx, 'PageInfo', field.name);
  }
}

function executeTypeField(ctx: ExecContext, typeName: string, field: GqlField, selection: GqlField[]): unknown {
  const fieldsFor = (name: string): string[] => {
    switch (name) {
      case 'Issue':
        return ISSUE_FIELDS;
      case 'PullRequest':
        return PULL_REQUEST_FIELDS;
      case 'Repository':
        return REPOSITORY_FIELDS;
      default:
        return [];
    }
  };
  switch (field.name) {
    case 'name':
      return typeName;
    case 'kind':
      return 'OBJECT';
    case 'fields': {
      const names = fieldsFor(typeName);
      return names.map((name) => {
        const out: Record<string, unknown> = {};
        for (const sub of selection) {
          if (sub.name === 'name') out[sub.alias ?? sub.name] = name;
          else if (sub.name === 'description') out[sub.alias ?? sub.name] = '';
          else out[sub.alias ?? sub.name] = null;
        }
        return out;
      });
    }
    case 'enumValues': {
      if (typeName !== 'SearchType') return [];
      return SEARCH_TYPE_VALUES.map((name) => {
        const out: Record<string, unknown> = {};
        for (const sub of selection) {
          if (sub.name === 'name') out[sub.alias ?? sub.name] = name;
          else out[sub.alias ?? sub.name] = null;
        }
        return out;
      });
    }
    default:
      return unknownField(ctx, '__Type', field.name);
  }
}

function executeCommentEdgeField(ctx: ExecContext, value: { repo: Repo; issue: Issue; comment: { id: number; body: string } }, field: GqlField, selection: GqlField[]): unknown {
  switch (field.name) {
    case 'node':
      return executeFields(ctx, 'Comment', value.comment, selection);
    case 'cursor':
      return encodeCursor(value.comment.id);
    default:
      return unknownField(ctx, 'CommentEdge', field.name);
  }
}

function executeCommentField(ctx: ExecContext, value: { id: number; body: string }, field: GqlField): unknown {
  switch (field.name) {
    case 'id':
      return Buffer.from(`forge:comment:${value.id}`, 'utf8').toString('base64');
    case 'body':
      return value.body;
    default:
      return unknownField(ctx, 'Comment', field.name);
  }
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^forge:repo:([^/]+)\/(.+)$/.exec(text);
    if (!match) return null;
    return store.getRepo(match[1], match[2]) ?? null;
  } catch {
    return null;
  }
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^forge:issue:([^/]+)\/([^:]+):(\d+)$/.exec(text);
    if (!match) return null;
    const repo = store.getRepo(match[1], match[2]);
    if (!repo) return null;
    const issue = repo.issues.find((entry) => entry.number === Number.parseInt(match[3], 10));
    return issue ? { repo, issue } : null;
  } catch {
    return null;
  }
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^forge:pr:([^/]+)\/([^:]+):(\d+)$/.exec(text);
    if (!match) return null;
    const repo = store.getRepo(match[1], match[2]);
    if (!repo) return null;
    const pull = repo.pulls.find((entry) => entry.number === Number.parseInt(match[3], 10));
    return pull ? { repo, pull } : null;
  } catch {
    return null;
  }
}

function resolveGlobalId(store: Store, id: string): { type: string; value: unknown } | null {
  const repo = findRepoByGlobalId(store, id);
  if (repo) return { type: 'Repository', value: repo };
  const issue = findIssueByGlobalId(store, id);
  if (issue) return { type: 'Issue', value: issue };
  const pull = findPullByGlobalId(store, id);
  if (pull) return { type: 'PullRequest', value: pull };
  return null;
}

function executeMutationField(ctx: ExecContext, field: GqlField): unknown {
  const selection = field.selection ?? [];
  const input = argValue(field, 'input', ctx.variables);
  const inputRecord = isRecord(input) ? input : {};
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = inputRecord.repositoryId;
      if (typeof repositoryId !== 'string') return null;
      const repo = findRepoByGlobalId(ctx.store, repositoryId);
      if (!repo) return null;
      const title = typeof inputRecord.title === 'string' ? inputRecord.title : '';
      const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
      const issue: Issue = {
        id: ctx.store.nextId(),
        number: repo.nextNumber++,
        title,
        body,
        state: 'open',
        labels: [],
        comments: [],
      };
      repo.issues.push(issue);
      const out: Record<string, unknown> = {};
      for (const sub of selection) {
        if (sub.name === 'issue') out[sub.alias ?? sub.name] = executeFields(ctx, 'Issue', { repo, issue }, sub.selection ?? []);
        else out[sub.alias ?? sub.name] = null;
      }
      return out;
    }
    case 'closeIssue': {
      const issueId = inputRecord.issueId;
      if (typeof issueId !== 'string') return null;
      const found = findIssueByGlobalId(ctx.store, issueId);
      if (!found) return null;
      found.issue.state = 'closed';
      const out: Record<string, unknown> = {};
      for (const sub of selection) {
        if (sub.name === 'issue') out[sub.alias ?? sub.name] = executeFields(ctx, 'Issue', found, sub.selection ?? []);
        else out[sub.alias ?? sub.name] = null;
      }
      return out;
    }
    case 'createPullRequest': {
      const repositoryId = inputRecord.repositoryId;
      if (typeof repositoryId !== 'string') return null;
      const repo = findRepoByGlobalId(ctx.store, repositoryId);
      if (!repo) return null;
      const headRef = typeof inputRecord.headRefName === 'string' ? inputRecord.headRefName : '';
      const baseRef = typeof inputRecord.baseRefName === 'string' ? inputRecord.baseRefName : repo.defaultBranch;
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined || baseSha === undefined) return null;
      const title = typeof inputRecord.title === 'string' ? inputRecord.title : '';
      const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
      const pull: PullRequest = {
        id: ctx.store.nextId(),
        number: repo.nextNumber++,
        title,
        body,
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
      const out: Record<string, unknown> = {};
      for (const sub of selection) {
        if (sub.name === 'pullRequest') out[sub.alias ?? sub.name] = executeFields(ctx, 'PullRequest', { repo, pull }, sub.selection ?? []);
        else out[sub.alias ?? sub.name] = null;
      }
      return out;
    }
    case 'mergePullRequest': {
      const pullRequestId = inputRecord.pullRequestId;
      if (typeof pullRequestId !== 'string') return null;
      const found = findPullByGlobalId(ctx.store, pullRequestId);
      if (!found) return null;
      const { repo, pull } = found;
      if (!pull.merged && pull.state === 'open') {
        const mergeSha = repo.squashMerge(pull);
        if (mergeSha !== null) {
          pull.merged = true;
          pull.mergedAt = FIXED_ISO;
          pull.mergeSha = mergeSha;
          pull.state = 'closed';
          repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        }
      }
      const out: Record<string, unknown> = {};
      for (const sub of selection) {
        if (sub.name === 'pullRequest') out[sub.alias ?? sub.name] = executeFields(ctx, 'PullRequest', { repo, pull }, sub.selection ?? []);
        else out[sub.alias ?? sub.name] = null;
      }
      return out;
    }
    case 'addComment': {
      const subjectId = inputRecord.subjectId;
      const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
      if (typeof subjectId !== 'string') return null;
      const found = findIssueByGlobalId(ctx.store, subjectId);
      if (!found) return null;
      const comment = { id: found.repo.nextCommentId++, body };
      found.issue.comments.push(comment);
      const out: Record<string, unknown> = {};
      for (const sub of selection) {
        if (sub.name === 'commentEdge') {
          out[sub.alias ?? sub.name] = executeFields(ctx, 'CommentEdge', { repo: found.repo, issue: found.issue, comment }, sub.selection ?? []);
        } else out[sub.alias ?? sub.name] = null;
      }
      return out;
    }
    default:
      return unknownField(ctx, 'Mutation', field.name);
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point: one document -> one result object; an array body -> an array.
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  const ctx: ExecContext = { store, variables, errors: [] };
  let operations: GqlOperation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'Empty GraphQL document.' }] };
  const operation = operations[0];
  const data: Record<string, unknown> = {};
  for (const field of operation.selection) {
    const key = field.alias ?? field.name;
    const typeName = operation.type === 'mutation' ? 'Mutation' : 'Query';
    data[key] = executeField(ctx, typeName, null, field);
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle a parsed JSON body (object or array of operations). */
export function handleGraphQLBody(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation needs a query string.' }] };
      }
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      return executeGraphQL(store, entry.query, variables);
    });
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'A GraphQL request needs a query string.' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  return executeGraphQL(store, body.query, variables);
}
