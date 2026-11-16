# UI Rule

- Do: Surface actionable diagnostics on init failure (e.g., `diagnosticMessage()` → `apple_intelligence_disabled` → "System Settings > Apple Intelligence & Siri"); keep toast messages single-line ≤120 chars with countdown `MM:SS` + local reset time (`16:08`); include `X-Apple-Compute-Target` + `X-Apple-FM-Context-Trimmed` headers for debug.
- Don't: Log prompt contents to disk or storage; expose raw bridge port/token in messages; block on-demand `/models` selection.
- Layout: No custom TUI UI today — toasts via `client.tui.showToast` (PRD) / future TUI companion; fallback `console.warn` + storage key `apple-fm.diagnostic` when TUI unavailable.
- States: Empty — provider unavailable (return early, no registration); Loading — bridge spawn with 15s timeout + stderr tail; Error — diagnostic written to server logs + storage, not thrown to user.
