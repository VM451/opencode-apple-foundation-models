# Build Plan

- [x] Phase 1 — Swift Bridge MVP: HTTP server on 127.0.0.1 with random bearer token, info-file handshake, `/health`, `/v1/models`, `/v1/chat/completions` (SSE + JSON), `SystemLanguageModel.default.availability`, context-limit clamp, `X-Apple-Compute-Target: on-device`, `SessionCache` (FR-2.3), 429 `Retry-After` / `rate_limited` handling (FR-3.1 Swift half).
- [x] Phase 2 — OpenCode Plugin & Failover State Machine: lifecycle (`BridgeManager`), two-model provider registration (FR-1.2), diagnostics (FR-1.3), `PccState` machine + `~/.cache/opencode/apple-fm-state.json` + `apple-fm.state` persistence (NFR-2), `http.response` 429 detector (FR-3.1), seamless failover (FR-3.2), `client.tui.showToast` + `/pcc-status --lock-local/--unlock` + footer (FR-3.3), per-second timer + health probe + switchback toast (FR-3.4).
- [x] Phase 3 — Agentic tool calling: OpenAI schemas → flat `GenerationSchema`, `DynamicTool` first-call abort, transcript rebuilding.
- [x] Phase 4 — Context Guardrails & Packaging: sliding window, instruction/prompt caps, `trimToBudget`, `X-Apple-FM-Context-Trimmed`, universal (`--universal`, lipo, `APPLE_FM_SIGN_IDENTITY` + `APPLE_NOTARY_PROFILE` `notarytool`/`stapler`) + `prepublishOnly` universal hook.
- [x] Phase 2b — PCC Failover & Countdown UX (complete): `parseRetryAfter` (header seconds/date, body), `isRateLimitError`, countdown `MM:SS` + `HH:MM`, `applyFailover/applySwitchBack`, toast fallbacks, `/pcc-status` synthetic + storage, model aliases, TUI companion (`src/tui.ts` `./tui`).

## Instructions

Phases per PRD §8. Scope checks per §5 FR-1–FR-4 / §6 NFR-1–NFR-4. Risks §9: PCC timestamp → default 30m + backoff probe; PCC access → on-device independent; overflow → trim; Gatekeeper → universal signed + notarize hooks.

## Remaining polish

- Market packaging: `opencode.json.example` is now PRD-aligned; consider adding `opencode marketplace` entry + docs and e2e `scripts/smoke-bridge.ts` extension for `/pcc-status` when run under `opencode serve`.
