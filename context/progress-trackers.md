# Progress Trackers

## 2026-11-16 - Kit scaffold + PRD full implementation

- Done: Scaffolded `context/` (9 flat) + `AGENTS.md`; implemented FR-1.1–1.4, FR-2.1–2.4, FR-3.1–3.4, FR-4.1, NFR-1–4. Swift: `SessionCache`, `BridgeError.rateLimited` + `isRateLimit` + `retryAfterReset`, 429 `Retry-After`/`X-Apple-PCC-State`, `pcc_state` in `HealthBody`; TS: `PccState` machine, `PccStore`, `toast.ts`, `/pcc-status`, auto-switchback timer, two-model registration; bundling: `build-swift.sh --universal`, `package.json ./tui` + `prepublishOnly`, `opencode.json.example` PRD-aligned. Verified: `bun test` 17 pass, `tsc --noEmit` clean, `scripts/smoke-bridge.ts` live (health + plain + tool on macOS 27 arm64), `npm run build:swift` debug 0, universal script arm64 fallback path tested.
- Decisions: PCC has no developer flag — bridge stays on-device, TS emulates PCC for 429-driven failover; hybrid `apple-hybrid` advertised 16384 vs real 4096 (documented clamp); `Retry-After` header is primary for Swift 429; per-second timer + `getpos` probe covers early resets; TUI companion as `./tui` keeps headless fallback via storage/console.
- Risks: Future Apple may expose PCC flag → need to plumb `X-Apple-Compute-Target: pcc` through `ModelRunner` vs current always `on-device`; Gatekeeper notarization requires Apple Developer ID — script is parameterized but no cert on this host; TTFT <400ms not formally asserted (depends on M-series model warm).
- Next: Marketplace packaging + `opencode serve` manual `/pcc-status` smoke; consider adding `scripts/pcc-smoke.ts` that forces a 429 and validates countdown; no further blocking code for PRD.

## 2026-11-16 - Initial implementation (pre-existing)

- Done: Bridge MVP, lifecycle, hybrid routing, context guardrail, tool calling.
- Decisions: Random port, UUID token, 32768 advertised.
- Risks: PCC missing.
- Next: Phase 2b now complete above.
