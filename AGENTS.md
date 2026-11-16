# AGENTS.md

Agent entry point. Durable context lives in `context/` — read this file first, then the context files you need. Keep code and context in sync: every code change ends with a context update in the same turn.

## Session protocol

1. Read `context/project-overview.md` and `context/progress-trackers.md` first (what this is, where it stands).
2. Read `context/architecture.md` + `context/code-standard.md` before touching code; add `context/library-docs.md` when using a dependency and `context/ui-*.md` when touching UI.
3. Build, then run lint + tests.
4. Update the affected `context/` files (see Context maintenance) before reporting done.

## Context map

- Product: `context/project-overview.md`
- System: `context/architecture.md`, `context/library-docs.md`
- Plan: `context/build-plan.md`, `context/progress-trackers.md`
- Standards: `context/code-standard.md`
- UI: `context/ui-rule.md`, `context/ui-registry.md`, `context/ui-token.md`

## Context maintenance (auto-update, no prompt needed)

After every code change — feature, fix, refactor, dependency, or UI work — update the affected `context/` files in the same turn, without being asked. The user should never have to say "update the context".

- Update one file or several, depending on what changed. Small change: one file. Feature: usually two to four.
- Routing: product/scope change → `project-overview.md`; structure/data-flow change → `architecture.md`; dependency added/removed/upgraded → `library-docs.md`; feature planned/started/finished → `build-plan.md`; convention introduced/changed → `code-standard.md`; component built/changed → `ui-registry.md`; visual value changed → `ui-token.md`; UI rule changed → `ui-rule.md`.
- Always append a dated entry to `context/progress-trackers.md` on feature work, fixes, and decisions.
- Never rewrite history in `progress-trackers.md` — append corrections as dated notes.
- Keep each file short and factual; match its existing format.

## Setup commands

- Install deps: `npm install`
- Start dev: `bun run typecheck`
- Build: `npm run build:swift`

## Testing

- Run tests: `bun test`
- Lint: `npm run typecheck`
- Always run lint + tests before finishing a task.

## Code style

- Stack: TypeScript 5.7 + Bun 1.1, Swift 6.2, Node >=20
- Strict TS + noEmit; Swift `swift` settings; no telemetry, no prompt logging
- Prefer existing patterns (`BridgeManager`, `diagnosticMessage`, `trimToBudget`) over new ones

## Project structure

- `src/`: TypeScript plugin (index, bridge, router, diagnostics, protocol)
- `swift/Sources/AppleFMBridge/`: Swift daemon (HTTPServer, ModelRunner, Types, ToolSupport, main)
- `tests/`: Bun tests
- `scripts/`: build-swift.sh + smoke-bridge.ts
- `bin/`: prebuilt `apple-fm-bridge` (gitignored)
- `context/`: durable agent context (9 flat files)

## Git workflow

- Branch: TBD; commits: TBD (not a git repo at this mount)
- PR title: TBD

## Boundaries (never do)

- Never commit secrets, credentials, or `.env` contents.
- Never touch: `bin/apple-fm-bridge` (generated), `swift/.build/` (breaks packaging), `node_modules/`
- Never create subfolders inside `context/` — nine flat files only.

## Security

- Loopback-only bind (127.0.0.1) with random UUID bearer token per process; never log prompt contents; never expose bridge on 0.0.0.0.
