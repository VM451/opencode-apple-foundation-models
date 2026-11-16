# UI Registry

## Diagnostics Message

- Where: `src/diagnostics.ts` `diagnosticMessage()`
- Pattern: Pure `(health|error) → string`; stored `apple-fm.diagnostic`, `console.warn` on startup failure.

## PCC Toasts

- Where: `src/toast.ts` `showToast()` + `src/pcc-state.ts` `toastMessageOnFailover` / `toastMessageOnReset`
- Pattern: `title/message/variant/duration`, tried via `client.tui.showToast` → `tui.toast.show` event → storage `apple-fm.toast` → `console.warn`. Failover default `8000ms` warning; switchback `success`.

## PCC Status Command

- Where: `src/index.ts` `ctx.command.transform` → `/pcc-status` + `ctx.session.synthetic`
- Pattern: Parses `--lock-local | --lock | --unlock`; default shows `Compute: … PCC resets in MM:SS (at HH:MM)`. Writes `apple-fm.pcc-status` for TUI footer; throws storage on toast failure doesn't block.

## TUI Footer

- Where: `src/tui.ts` `tui.buildStatus` + `component` stub
- Pattern: `prompt.footer.status` displays `Apple FM: PCC preferred` vs `Apple FM: on-device (PCC resets in MM:SS at HH:MM)` vs `Apple FM: on-device (locked)`; no-op when Solid missing.

## Health Response

- Where: Swift `HealthBody` → TS `HealthResponse` (`src/protocol.ts`)
- Pattern: `{ status, available, reason, detail, model, context, compute_target, pcc_state, pcc_reset_at, pid }`.

## Context Guardrail Headers

- Where: Swift `HTTPServer.swift` + TS `trimToBudget`
- Pattern: Every JSON/SSE response carries `X-Apple-Compute-Target: on-device`; non-SSE carries `X-Apple-FM-Context-Trimmed: <n>`; 429 carries `Retry-After` + `X-Apple-PCC-State: rate_limited`.
