# Vikunja MCP Server

A Model Context Protocol (MCP) server that enables AI assistants to interact with Vikunja task management instances.

> **Fork — working as of July 2026.** This is a fork of
> [`democratize-technology/vikunja-mcp`](https://github.com/democratize-technology/vikunja-mcp),
> maintained at [`eljojo/vikunja-mcp`](https://github.com/eljojo/vikunja-mcp) and verified working
> against a current Vikunja instance as of **July 2026**. The fork's own history starts 2026-07-07;
> on top of upstream it adds:
> - the **`vikunja_kanban`** tool — list/create/update/delete board columns (buckets), move tasks
>   between them, set the default/done column, and apply a column template;
> - **reliability fixes** — honor `bucketId` on task create, accept `id`/`projectId` and
>   `bucketId`/`intoBucketId` aliases, return the whole forest from `get-tree`, and run bulk updates
>   sequentially with per-task retry + verification.
>
> **Install:** grab the one-click [`.mcpb` bundle](https://github.com/eljojo/vikunja-mcp/releases/latest)
> for Claude Desktop, or add the `mcpServers` config for Claude Code and other clients — see
> [Installation](#installation). (Not on npm; the upstream `@democratize-technology/vikunja-mcp`
> package lacks these additions.)

## Features

- **Subcommand-based tools** for intuitive AI interactions
- **Session-based authentication** with automatic token management
- **Full task management** operations implemented
- **Complete project management** with CRUD operations
- **Label management** for organizing tasks
- **Team operations** for collaboration (get/update/members limited by API)
- **User management** with settings and search
- **Webhook management** for project automation
- **Batch import** tasks from CSV or JSON files
- **Input validation** for dates, IDs, and hex colors
- **Efficient diff-based updates** for assignees
- **TypeScript with strict mode** for type safety
- **Comprehensive error handling** with typed errors and centralized utilities
- **Retry logic** with an opossum circuit breaker
- **Zod-based input validation** with DoS protection and rate limiting
- **Memory protection** with pagination limits and usage monitoring

## Requirements

- Node.js 20+ (LTS versions only)
- Vikunja instance with API access
- API token (starting with `tk_`) or JWT token for authentication

## Installation

- **Using Claude Desktop?** Install the prebuilt bundle — one click, no JSON (Option 1).
- **Claude Code or another MCP client?** Add a `vikunja` entry under `mcpServers` in your config
  file (Option 2 or 3).

### Option 1 — Claude Desktop bundle (`.mcpb`, easiest)

Download **[`vikunja-mcp.mcpb`](https://github.com/eljojo/vikunja-mcp/releases/latest)** from the
latest release, then in Claude Desktop open **Settings → Extensions** and drag the file in (or just
open it). It prompts for your Vikunja URL and API token on install — no config files to edit. The
bundle is a single cross-platform build (macOS / Windows / Linux) produced by the `Build MCP bundle`
GitHub Action on every `v*` tag.

### Option 2 — `mcpServers` config, run from GitHub (no clone)

Point `npx` at this fork's repo; it builds itself on first launch. Add this under `mcpServers` in
your client's config file:

- **Claude Code** — `.mcp.json` at your project root (or run `claude mcp add`), or the `mcpServers`
  block of `~/.claude.json`.
- **Claude Desktop** — `claude_desktop_config.json`
  (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`).

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "npx",
      "args": ["-y", "github:eljojo/vikunja-mcp"],
      "env": {
        "VIKUNJA_URL": "https://your-vikunja-instance.com/api/v1",
        "VIKUNJA_API_TOKEN": "tk_your-api-token"
      }
    }
  }
}
```

### Option 3 — `mcpServers` config, local build (pinned checkout / development)

```bash
git clone https://github.com/eljojo/vikunja-mcp.git
cd vikunja-mcp
npm install
npm run build
```

Then point the config at the built entrypoint (use an absolute path):

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "node",
      "args": ["/absolute/path/to/vikunja-mcp/dist/index.js"],
      "env": {
        "VIKUNJA_URL": "https://your-vikunja-instance.com/api/v1",
        "VIKUNJA_API_TOKEN": "tk_your-api-token"
      }
    }
  }
}
```

> The upstream `@democratize-technology/vikunja-mcp` npm package does **not** include this fork's
> Kanban tool or fixes — use any option above to get them. (`VIKUNJA_API_TOKEN` accepts a `tk_` API
> token or a JWT; see [Authentication Methods](#authentication-methods).)

## Authentication Methods

The Vikunja MCP server supports two authentication methods, each with different capabilities:

### API Token Authentication (Default)

API tokens are the standard authentication method for Vikunja:

- **How to obtain:** Go to Vikunja Settings → API Tokens → Create new token
- **Token format:** Starts with `tk_` (e.g., `tk_abc123def456`)
- **Capabilities:** Full access to tasks, projects, labels, teams, and webhooks
- **Limitations:** Cannot access user-specific endpoints (user profile, settings, export)
- **Best for:** Automation, CI/CD, and general task management

### JWT Authentication (Advanced)

JWT (JSON Web Token) authentication provides full access to all Vikunja endpoints:

- **How to obtain:** Extract from your browser session (see instructions below)
- **Token format:** Long string starting with `eyJ` (standard JWT format)
- **Capabilities:** Full access to all endpoints including user management and export
- **Limitations:** Tokens expire (typically after 24 hours)
- **Best for:** User management, data export, and operations requiring user context

#### How to Extract Your JWT Token

1. **Log into Vikunja** in your web browser
2. **Open Developer Tools** (F12 or right-click → Inspect)
3. **Go to the Application/Storage tab**
4. **Find the JWT token:**
   - Look in Local Storage → your Vikunja domain
   - Find the key named `token` or similar
   - The value is your JWT token
5. **Copy the entire token value** (it's quite long)

#### Using JWT Authentication

```typescript
// Connect with JWT token - automatically detected!
vikunja_auth.connect({
  apiUrl: "https://your-vikunja-instance.com/api/v1",
  apiToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
})
```

**Important Notes:**
- JWT tokens expire; you'll need to extract a new one when it expires
- Token type is automatically detected based on format (no flag needed)
- Some tools (users, export) are only available with JWT authentication

## What it adds over the Vikunja API

This isn't a thin passthrough — it wraps the Vikunja API with the ergonomics and safety a
task-management assistant actually needs:

- **Kanban boards, safely.** `vikunja_kanban` creates, renames, reorders, and limits columns and
  moves tasks between them. Deleting a column relocates its tasks to a live column *first* (never
  orphans them), destructive ops accept `dryRun` to preview, and `apply-template` makes a board's
  columns match an ordered list — *"apply `[now, next, someday, done]` to this project"* — in one call.
- **Mutations that verify themselves.** Bulk updates run one task at a time with per-task retry and a
  read-back check; creating a task into a column confirms it actually landed. Partial failures come
  back with the exact task IDs, not a silent drop.
- **Lists you can actually read.** Task lists come grouped by project with resolved names, each task's
  current Kanban column, compact tables, and an optional "updated N ago" staleness signal — instead
  of raw JSON.
- **Batch import.** Load tasks from CSV or JSON, resolving label and assignee *names* to IDs, with a
  `dryRun` validation mode.
- **Templates & filtering.** Project templates with variable substitution (`{{PROJECT_NAME}}`,
  `{{TODAY}}`, …); hybrid filtering that tries server-side first and falls back to client-side with
  memory guards, using Vikunja's filter syntax.
- **Forgiving inputs.** Accepts `id`/`projectId` and `bucketId`/`intoBucketId` interchangeably and
  coerces stringified numbers, so calls don't fail on trivial parameter mismatches.

## Using it

You don't invoke these tools by hand — you talk to your assistant in natural language, and it picks
the right tool and arguments from the schemas it receives over MCP. Once connected (see
[Installation](#installation)), prompts like these just work:

- *"Add 'renew passport' to my Life project, due next Friday, high priority."*
- *"Show me everything in Life that isn't done, grouped by project."*
- *"Set up a board on Home with columns now, next, someday, done — make done the done column."*
- *"Move 'call the plumber' to the next column."*
- *"Import the tasks in tasks.csv into project 4."*

The assistant reads the tool list below and figures out the rest.

## Available Tools

All tools need an active connection (`VIKUNJA_URL` + `VIKUNJA_API_TOKEN`, or `vikunja_auth`). Tools
marked **JWT** need a JWT token rather than a `tk_` API token.

| Tool | What it does | Auth |
| --- | --- | --- |
| `vikunja_auth` | Connect, check status, disconnect | — |
| `vikunja_tasks` | Tasks: create, get, update, delete, list/filter. Also split into `vikunja_task_crud`, `_task_bulk`, `_task_assignees`, `_task_comments`, `_task_labels`, `_task_relations`, `_task_reminders` for granular use | — |
| `vikunja_projects` | Projects CRUD, archive/unarchive, hierarchy (children/tree/breadcrumb/move), sharing | — |
| `vikunja_kanban` | Board views, columns (buckets), move tasks, set default/done column, apply a column template | — |
| `vikunja_labels` | Labels CRUD; apply/remove labels on tasks | — |
| `vikunja_filters` | Saved filters: build, validate, list, create, update, delete | — |
| `vikunja_templates` | Capture a project as a template; instantiate it with variable substitution | — |
| `vikunja_teams` | List, create, delete teams | — |
| `vikunja_webhooks` | Project webhooks CRUD with event validation | — |
| `vikunja_batch_import` | Import tasks from CSV/JSON (name→ID lookup, dry-run) | — |
| `vikunja_users` | Current user, search, settings | JWT |
| `vikunja_export_project`, `vikunja_request_user_export`, `vikunja_download_user_export` | Export a project or full user data | JWT |

## Not covered

- **File attachments** — MCP can't transfer files, so task attachments aren't implemented.
- **Some team operations** — get-by-id, update, and member management aren't in the underlying
  `node-vikunja` client yet (list / create / delete work).
- **A few user / bulk / label endpoints** can return auth errors on some Vikunja versions even with a
  valid token — the server reports a clear message when that happens.
- Not a 1:1 mirror of the Vikunja API — this targets the task / project / board workflow, not every
  endpoint.

## Configuration

### Environment Variables

The server supports various configuration options through environment variables:

#### Basic Configuration
```bash
# Vikunja instance URL (required)
VIKUNJA_URL=https://your-vikunja-instance.com/api/v1

# Authentication token (required)
VIKUNJA_API_TOKEN=your-api-token

# Enable debug logging (default: false)
DEBUG=true

# Set log level (error, warn, info, debug)
LOG_LEVEL=debug
```

All logs go to stderr (stdout is reserved for the MCP protocol), with timestamps and levels — e.g.
`[2026-07-08T17:00:00.000Z] [INFO] Vikunja MCP server started`.

#### Security & Performance Configuration
```bash
# Rate limiting (default: enabled)
RATE_LIMIT_ENABLED=true
RATE_LIMIT_PER_MINUTE=60        # Requests per minute (default: 60)
RATE_LIMIT_PER_HOUR=1000        # Requests per hour (default: 1000)

# Request size limits (default: 1MB)
MAX_REQUEST_SIZE=1048576        # Maximum request payload size in bytes
MAX_RESPONSE_SIZE=10485760      # Maximum response size in bytes (default: 10MB)

# Execution timeout (default: 30 seconds)
EXECUTION_TIMEOUT=30000         # Tool execution timeout in milliseconds

# Memory protection (default: enabled)
MEMORY_PROTECTION_ENABLED=true
MAX_TASKS_PER_REQUEST=1000      # Maximum tasks to load per request

# Circuit breaker configuration (opossum)
CIRCUIT_BREAKER_ENABLED=true    # Enable circuit breaker for API calls
CIRCUIT_BREAKER_TIMEOUT=60000   # Circuit breaker timeout in milliseconds (default: 60s)
CIRCUIT_BREAKER_ERRORS_THROTTLE=10 # Errors before opening circuit (default: 10)
CIRCUIT_BREAKER_RESET_TIMEOUT=30000 # Time to wait before trying half-open state (default: 30s)

# Filter security (Zod validation)
FILTER_MAX_LENGTH=1000          # Maximum filter string length (default: 1000)
FILTER_MAX_VALUE_LENGTH=200     # Maximum individual value length (default: 200)
```

#### Response Verbosity
```bash
# minimal | standard | detailed | complete (default: standard)
VIKUNJA_RESPONSE_VERBOSITY=standard

# Optional comma-separated field overrides
VIKUNJA_RESPONSE_INCLUDE_FIELDS=reminders,repeat_after
VIKUNJA_RESPONSE_EXCLUDE_FIELDS=hex_color,position
```

Tool-level `verbosity` parameters override the global level. Field overrides
apply afterward; required identity fields (`id` and `title`) are always kept.

For detailed rate limiting configuration, see [`docs/RATE_LIMITING.md`](docs/RATE_LIMITING.md).

## Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and workflow.

## License

MIT
