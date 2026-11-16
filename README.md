# makefun-github-core-clone-01

A standalone, GitHub-compatible git forge, written for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01). One Node 22
process, standard library only, no dependencies, no git binary: it implements
the git pack protocols itself (pkt-line framing, packfiles, deltas) on
`node:zlib` / `node:crypto`.

## What it serves

| Surface | Routes |
| --- | --- |
| git smart HTTP | `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack` (protocol v2 with ls-refs/fetch, plus a v0 fallback) and `git-receive-pack` (v0, report-status over side-band-64k, fast-forward enforcement) |
| REST v3 | `/api/v3` — repositories, branches, commits, contents, labels, issues, comments, pull requests and squash merges, with Link pagination |
| GraphQL v4 | `/api/graphql` — the documents `gh` and `github-mcp-server` send, including introspection, cursor pagination, mutations and operation batching |
| MCP | `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 (`server/discover`, `initialize`, `tools/list`, `tools/call`, 12 tools) on the same store as REST |

Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token
is 401, and a repository under another owner's login is 404, never 403. Every
REST reply is `application/json` with a non-empty `X-GitHub-Request-Id`.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done`, and exits 0 when
the trial is over (see `main.ts`). Set `MAKEFUN_SHOP_TOKEN` to the token the
suite presents; when it is unset, auth is not enforced (local development).

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP server, REST v3 routes, and dispatch to the other surfaces.
- `store.ts` — the in-memory data model: repositories, git objects, refs, issues, pull requests, merges, packfile read/write.
- `gitproto.ts` — pkt-line codec, v2/v0 advertisements, ls-refs, fetch, receive-pack.
- `graphql.ts` — a small GraphQL parser + executor for the suite's documents.
- `mcp.ts` — the MCP endpoint and its twelve tools.

## v2: caching + fast parser

v2 keeps v1's wire behaviour byte for byte and removes repeated work:

- **Fetch cache**: a fetch response (selection + pack + framing) is cached per
  repository, keyed by the fetch's inputs plus the object generation, which
  bumps on every stored object. Objects are immutable and append-only, so a
  cached response is never stale; a later push bumps the generation and the
  key misses. The clone workload's 50 identical depth-1 clones build the pack
  once.
- **Deflate cache**: pack object bytes are deflated once per oid and reused
  across packs (object data is immutable).
- **Advertisement / ls-refs caches**: the v2 advertisement is a constant; the
  v0 advertisement and ls-refs responses are cached per refs generation.
- **Push fast path**: a push whose new commit's parent is the old tip is
  confirmed fast-forward with one parse instead of a walk of the whole
  history; merges and rebases still take the full ancestor walk.
- **REST fast path**: one URL parse per request, percent-decoding only when a
  segment carries `%`, O(1) issue/pull lookup by number, and the serialized
  JSON of an issue cached on the issue until a mutation clears it (the read
  workload asks for the same issue 2,000 times).
- **Fast pkt-line decoding**: hex lengths parsed by table lookup, no regex.

Determinism: the server invents no timestamps and no unseeded randomness —
server-created commits use a fixed epoch plus a sequence number, and global
ids are derived from stable identities — so a replay of a trial sees the same
state.

## Referral

Built for make.fun — [join with my referral link](https://make.fun/r/kfz6780b).
