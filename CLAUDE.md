# CLAUDE.md

Guidance for AI agents working in this repository.

## What this is

An **MCP (Model Context Protocol) server** that exposes a [Vikunja](https://vikunja.io)
task manager as tools an AI assistant can call. It talks to a Vikunja instance over its
REST API (via the `node-vikunja` client) and speaks MCP over stdio.

It is a TypeScript/Node project, published to npm as `@eljojo/vikunja-mcp` and also
bundled as a one-click `.mcpb`. The primary real-world consumer is a personal
life-planning workflow (see `~/code/life`), so **the tools that matter most in practice
are tasks, projects, kanban, labels, and filters** — that's where to spend care.

> This fork descends from an upstream that shipped in one large "enterprise-grade"
> commit. Some of the original module structure is heavier than the job needs and some
> code is under-tested or unused. Prefer deleting dead code over documenting it. If a
> claim in a comment sounds like marketing ("battle-tested", "production-ready"), treat
> it as unverified.

## Commands

```bash
npm run dev             # tsx watch — run the server against a live Vikunja for manual testing
npm run build           # tsc → dist/
npm run typecheck       # tsc --noEmit
npm run lint            # eslint src
npm run test            # jest (silent)
npm run test:coverage   # jest with coverage
npm run test:mcp        # integration test against a real Vikunja (scripts/test-mcp.ts)
npm run format          # prettier over src/ and tests/

# Targeted tests (prefer these while working)
npx jest tests/tools/labels.test.ts        # one file
npx jest -t "should create task"           # one test by name
```

**Before handing work back:** `npm run lint && npm run typecheck && npm run test:coverage`
must pass. The server is loaded by Claude Desktop from this local checkout — a rebuild
alone doesn't hot-reload it; the user must restart Claude Desktop to pick up a new build.

## Architecture

### Entry & registration
- `src/index.ts` — starts `McpServer` on stdio transport.
- `src/tools/index.ts` — `registerTools()`, the one place tools are wired up.
  Registration is **conditional**:
  - Auth and task tools are always registered.
  - Most tools need a `clientFactory` (an authenticated Vikunja client).
  - `users` and `export` are registered **only under JWT auth** (an API token can't reach
    those endpoints).
- `src/client.ts` / `src/client/` — session-aware Vikunja client construction.
- `src/auth/AuthManager.ts` — holds the session and auto-detects token type.

### Auth
Token format decides everything:
- **API token** (`tk_*`) — standard auth; excludes user-management and export tools.
- **JWT** (`eyJ*`) — full access including `users` and `export`.

Sessions live in memory only; they reset when the server restarts. Credentials are masked
in logs.

### Tool pattern
Every tool is one `server.tool(name, description, zodSchema, handler)` call, dispatching on
a `subcommand` / `operation` / `action` enum inside the handler. Zod validates arguments.
Errors flow through `src/utils/error-handler.ts` and surface as `MCPError` with a code.

### Tool map

| Tool | Ops | Notes |
|---|---|---|
| `vikunja_auth` | connect, status, refresh, disconnect | always registered |
| `vikunja_task_crud` | create, get, update, delete, list | **preferred** task tool; `list` resolves project + kanban column names |
| `vikunja_tasks` | list, … | older comprehensive tool with a heavier formatter — prefer `task_crud` |
| `vikunja_task_bulk` | bulk-create, bulk-update, bulk-delete | one API call per task (Vikunja has no batch endpoint) |
| `vikunja_task_assignees` | assign, unassign, list-assignees | |
| `vikunja_task_labels` | apply-label, remove-label, list-labels | per-task |
| `vikunja_task_comments` | comment | |
| `vikunja_task_reminders` | add-reminder, remove-reminder, list-reminders | |
| `vikunja_task_relations` | relate, unrelate, relations | |
| `vikunja_projects` | list, get, create, update, delete, archive/unarchive, tree/children/breadcrumb, move, shares | |
| `vikunja_kanban` | list-views, list-buckets, create/update/delete-bucket, move-task, bulk-move, set-view-config, apply-template | `viewId` auto-resolves; see filtering notes |
| `vikunja_labels` | list, get, create, update, delete | |
| `vikunja_filters` | list, get, create, update, delete, build, validate | see **Filtering** |
| `vikunja_teams` | list, get, create, update, delete, members | node-vikunja team support is partial |
| `vikunja_users` | current, search, settings, update-settings | JWT only |
| `vikunja_templates` | create, list, get, update, delete, instantiate | |
| `vikunja_webhooks` | list, get, create, update, delete, list-events | |
| `vikunja_batch_import` | (csv/json) | |
| `vikunja_export` | | JWT only |

### Where to add code
- **New tool** → `src/tools/<entity>/` (or `src/tools/<entity>.ts`), then register it in
  `src/tools/index.ts`, then add `tests/tools/<entity>.test.ts`.
- **New op on an existing tool** → extend its enum + add a `case` in the handler.
- **Shared validation / errors** → `src/utils/`.

## Filtering

Two separate mechanisms both wear the word "filter" — keep them distinct:

1. **Filter execution (the hybrid engine).** When a task list is filtered, the MCP sends
   `filter=` to Vikunja **server-first**, then narrows the remainder in memory. The
   client-side pass exists because Vikunja's server filter has real gaps this fork hit: it
   can't filter by kanban **bucket id**, and the API caps a page at **50**, so full-set
   reads and bucket filtering are finished client-side. Lives in
   `src/tools/tasks/filtering/` and `src/utils/filtering/`. This is legitimate — leave it.

2. **Saved filters** (`vikunja_filters` create/get/update/delete/list). These persist as
   **Vikunja server saved filters** (`node-vikunja`'s `FilterService` → the `/filters`
   endpoint), so they sync to the Vikunja web app and mobile. Vikunja surfaces saved
   filters as negative-ID pseudo-projects in the projects list; the mapping is
   `projectID = -filterID - 1`. `build` and `validate` are pure helpers for composing and
   checking a Vikunja filter-DSL string (no server call).

The Vikunja filter DSL is documented at <https://vikunja.io/docs/filters>.

## Testing

Coverage is enforced by jest at **65% branches / 65% functions / 75% lines / 75%
statements** (see `jest.config`). Current actual is roughly **80% lines / 70% branches** —
above the floor, not comprehensive. The weakest spots are also the most-used tools
(`kanban.ts`, `task-crud.ts`, task-display enrichment); new work on those should raise
coverage, not coast on the average.

- `tests/` mirrors `src/`. Tool tests invoke the registered handler directly (they don't
  round-trip through the MCP transport or Zod), so schema-level normalization/validation is
  exercised by the SDK at runtime, not by these unit tests — assert behavior in the handler.
- All `node-vikunja` calls are mocked; there is no live server in unit tests.
- **If code can't be reached by a test, prefer deleting it over adding defensive branches**
  you then have to mock into existence.
- `npm run test:mcp` exercises the server end-to-end against a real Vikunja; see
  `docs/MCP-TEST-CHECKLIST.md` for manual checks.

## Known constraints

- **Vikunja API:** server-side filtering is limited (no bucket-id filter, 50/page cap) —
  hence the hybrid engine above. Kanban buckets belong to a **view**, not directly to a
  project, so bucket ops take `projectId` + `viewId`.
- **node-vikunja:** team operations are incomplete; some user endpoints are JWT-only.
- **MCP:** no file attachments; tool calls are synchronous; no shared state between calls
  beyond the in-memory session.
- **Node 20+**, TypeScript strict mode.

## Git / workflow

This is a personal fork (`@eljojo/...`); releases are tagged directly on `main`. Match the
existing plain commit-message style (no emoji-prefixed "enterprise-grade" messages). Keep
changes to one coherent, verified unit per commit, and run lint + typecheck + coverage
before pushing.
