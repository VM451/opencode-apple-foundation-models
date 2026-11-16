# Code Standard

- Style: TypeScript ES2022, `ESNext` + `Bundler` resolution, `strict: true`, `skipLibCheck: true`, no emit; `verbatimModuleSyntax` follow existing `import type` usage; Swift with `swift` URL pattern; no telemetry / no prompt logging anywhere.
- Naming: Files `lower-case.ts`/`UpperCamel.swift` matching existing (`bridge.ts`, `HTTPServer.swift`); exports `PascalCase` classes, `camelCase` functions; constants `MODEL_ID`, `PROVIDER_ID`, `APPLE_FM_BRIDGE_*`.
- Testing: Bun `bun:test` (`describe`/`test`/`expect`), colocated `tests/*.test.ts`; pure logic factored to `router.ts` / `pcc-state.ts` for TTL; live smoke via `scripts/smoke-bridge.ts` (not in `bun test`).
- Git: TBD — no branch/commit convention observed in repo (not a git repo at mounted path); keep local commits conventional `type(bridge|plugin): message` if tooling added.
- Formatting: Prettier TBD; run `npx tsc --noEmit` before every PR.
