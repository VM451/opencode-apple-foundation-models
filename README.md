# opencode-apple-foundation-models

OpenCode provider for Apple's on-device Foundation Models (`FoundationModels` / `SystemLanguageModel`). Zero API cost, zero prompt egress, runs locally on Apple Silicon with automatic PCC→on-device failover and live countdown.

> Naming note: Apple Intelligence is the consumer UI (Siri, Writing Tools, Genmoji). Third-party LLM access is via the FoundationModels framework — hence the package name.

## Requirements

- Apple Silicon Mac (M1+), macOS 26 (Tahoe) or later
- Apple Intelligence enabled with model assets downloaded (System Settings > Apple Intelligence & Siri)
- OpenCode v2 (tested with 2.1.4)
- Xcode Command Line Tools for building the bridge (prebuilt `bin/apple-fm-bridge` via `npm run build:swift:universal` skips this)

## Install

The plugin auto-registers the `apple-fm` provider — no manual `provider` block needed for the basic case. For PRD-aligned config, use `opencode.json.example`:

```jsonc
// ~/.config/opencode/opencode.jsonc - minimal
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-apple-foundation-models"],
  "model": "apple-fm/apple-hybrid"
}
```

PRD config (two models + `pccFailover`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-apple-foundation-models"],
  "provider": {
    "apple-fm": {
      "name": "Apple Foundation Models (PCC + On-Device)",
      "options": {
        "pccFailover": {
          "enabled": true,
          "defaultCooldownMinutes": 30,
          "autoSwitchBack": true,
          "notifyOnSwitch": true
        }
      },
      "models": {
        "apple-hybrid": { "limit": { "context": 16384, "output": 4096 } },
        "apple-on-device": { "limit": { "context": 8192, "output": 2048 } }
      }
    }
  }
}
```

The plugin picks a free loopback port, generates a random bearer token, and registers the provider automatically. Setting `provider.apple-fm.options.baseURL` in config pins a port if desired — the plugin still starts the bridge if not already running.

### Models

| ID | Name | Use |
| --- | --- | --- |
| `apple-hybrid` | Apple Hybrid (PCC with On-Device FM Failover) | Preferred; stays on-device unless PCC quota trips + `hybrid.fallback` routes heavy prompts |
| `apple-on-device` | Apple Foundation Model (Strict On-Device) | Always on-device, never delegates |
| `system-language-model` | Legacy alias | Back-compat with early installs |

Advertised limits are 16384/4096 (hybrid) and 8192/2048 (on-device). The Swift bridge clamps to the OS-reported ~4096 hard limit at runtime.

## Options

Plugin options via the object form:

```jsonc
{
  "plugins": [{
    "package": "opencode-apple-foundation-models",
    "options": {
      "context": 4096,
      "maxOutput": 1024,
      "port": 0,
      "startTimeoutMs": 15000,
      "pccFailover": {
        "enabled": true,
        "defaultCooldownMinutes": 30,
        "autoSwitchBack": true,
        "notifyOnSwitch": true
      },
      "hybrid": {
        "threshold": 2048,
        "fallback": { "providerID": "anthropic", "modelID": "claude-sonnet-4-5" }
      }
    }
  }]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `context` | 4096 | Bridge context budget (clamped to `SystemLanguageModel.contextSize`) |
| `maxOutput` | 1024 | Max generated tokens per response |
| `port` | `0` | Fixed loopback port; `0` lets the OS choose |
| `bridgePath` | auto | Explicit path to `apple-fm-bridge` |
| `pccFailover.enabled` | `true` | Enable PCC failover state machine |
| `pccFailover.defaultCooldownMinutes` | `30` | Fallback cooldown when Apple omits `Retry-After` |
| `pccFailover.autoSwitchBack` | `true` | Probe + toast when PCC quota resets |
| `pccFailover.notifyOnSwitch` | `true` | Fire toast on failover / switchback |
| `hybrid.threshold` | 2048 | Estimated tokens above which `fallback` takes over |
| `hybrid.fallback` | none | Provider/model for heavy prompts (cloud) |

`APPLE_FM_BRIDGE_PATH` overrides binary discovery. `APPLE_FM_DEBUG=1` enables bridge stderr + plugin debug logs.

## PCC failover & countdown (FR-3)

Apple has no developer flag to force Private Cloud Compute for third-party prompts. The bridge therefore always executes on-device (`X-Apple-Compute-Target: on-device`). The TypeScript state machine emulates PCC semantics so the UX survives any future OS PCC flag and downstream 429s from compatible bridges.

- **Quota detection (FR-3.1)**: `http.response` hook + Swift `BridgeError.rateLimited` capture 429 / `rate_limit_error` / Retry-After. Swift extracts `Retry-After` (seconds or HTTP date) or `reset_at` from NSError `userInfo`; otherwise falls back to `defaultCooldownMinutes`. State is persisted to `~/.cache/opencode/apple-fm-state.json` (NFR-2) so countdowns survive restarts.
- **Seamless failover (FR-3.2)**: When `X-Apple-Compute-Target` flips or 429 arrives, `applyFailover` sets `activeTarget: on-device`, retries are served on-device within <100ms, no prompt drop. During cooldown `model.request` annotates `x-apple-force-on-device` and the hybrid `model.resolve` gate stays local.
- **Live countdown (FR-3.3)**:
  - Toast on failover: `PCC usage limit reached. Switched to on-device Apple Foundation Model. PCC resets in 24m 15s (at 16:08).` via `client.tui.showToast` when the TUI client is present; falls back to `apple-fm.toast` storage + `console.warn` (see `src/toast.ts`).
  - Command `/pcc-status` — global OpenCode slash command. Shows `Compute: PCC (preferred) — No cooldown` or `Compute: on-device (PCC cooldown) — PCC resets in 24m 15s (at 16:08)`. Schedules a per-second background tick so the stored status is always fresh; also writes `apple-fm.pcc-status` for the TUI footer.
  - Manual lock: `/pcc-status --lock-local` pins on-device; `/pcc-status --unlock` resumes PCC preference.
- **Auto switch-back (FR-3.4)**: Background `setInterval(1000)` + `setTimeout` aligned to `resetAt` probes `manager.health()` when `now >= resetAt`. On success calls `applySwitchBack` and fires `Private Cloud Compute quota has reset! Automatically switched back …` toast.

## Hybrid routing (FR-4.1)

With `hybrid.fallback` set, a `model.resolve` hook sends heavy prompts (token estimate > threshold or `refactor|rewrite|whole project|…` keywords) to the configured cloud model. Everything else stays on-device at $0, preserving cloud quota. Simple tasks (commit messages, docstrings, small edits under threshold) always stay on-device. When PCC is in cooldown the hook stays on-device regardless — never burns cloud during the window.

If you want PCC-like gatewaying during cooldown or for PCC-scale reasoning, point `hybrid.fallback` to Ollama (or any OpenAI-compatible cloud). `apple-on-device` continues to work 100% independently at $0.

## Architecture

```
OpenCode v2 (Bun)
  └─ plugin (src/index.ts)
       ├─ lifecycle: spawn / health / shutdown bridge (FR-1.1)
       ├─ provider registration via ctx.provider.transform (FR-1.2) — two models
       ├─ PccState machine (src/pcc-state.ts) + disk persistence (src/pcc-store.ts)
       ├─ toast helper (src/toast.ts) + /pcc-status command + auto-switchback timer
       └─ hybrid model.resolve hook (FR-4.1)
            ↕ HTTP 127.0.0.1:<random> + bearer token (NFR-1)
apple-fm-bridge (Swift, FoundationModels)
  ├─ GET  /health  (with pcc_state / pcc_reset_at, FR-2.4)
  ├─ GET  /v1/models
  ├─ POST /v1/chat/completions  (SSE + JSON, FR-2.1)
  ├─ SessionCache (FR-2.3) — 32 entries, 5min TTL, keyed by conversation_id
  └─ SystemLanguageModel.default → LanguageModelSession
```

- Native tool calling (FR-2.2): OpenAI tool schemas are converted to flat `GenerationSchema` properties, exposed as `Tool` conformances (`SchemaConverter` caps at 4 props, 100-char desc). `DynamicTool` records the first call, aborts the model's loop, and emits OpenAI `tool_calls`. OpenCode executes the tool and sends the result back; the bridge rebuilds the transcript (including `ToolOutput`) and continues.
- Context guardrail (FR-1.4): Sliding window trims oldest turns before the 4096 hard limit. Streams natively adapt; every response exposes `X-Apple-Compute-Target: on-device` and `X-Apple-FM-Context-Trimmed`. The TS `trimToBudget` mirrors the server logic for hybrid planning.
- Security (NFR-1/2): Loopback-only bind, random UUID bearer token per process, no prompt logging (`debugRequest` only logs `roles,chars,tools`), no telemetry. Cooldown timestamps only in `~/.cache/opencode/apple-fm-state.json`.

## Build

```sh
npm install
npm run build:swift          # arm64 bridge -> bin/
npm run build:swift:universal # universal (arm64+x86_64) via lipo when possible
npm run typecheck
bun test
```

For distribution, set `APPLE_FM_SIGN_IDENTITY="Developer ID Application: ..."` (and optionally `APPLE_NOTARY_PROFILE` for `notarytool`) when building, then notarize with Apple. Without signing, Gatekeeper may block the binary. `prepublishOnly` builds the universal binary automatically.

## Limitations / reality check

- **PCC**: No developer flag today — all inference is on-device. The PCC plumbing is future-proof and emulates quotas via 429/`Retry-After` when a bridge/OS starts reporting them; `hybrid.fallback` is the PCC surrogate today.
- **Context**: OS reports 4096 tokens; advertised hybrid 16384 is just OpenCode's auto-compaction buffer and is clamped in the bridge.
- **Tools**: Nested JSON schemas are flattened to strings; flat primitive arguments are reliable, deep structures are not. Keep schemas small for the ~3B model's 4096 budget.
- **macOS 26 only**: On macOS 25 or Intel, the bridge refuses to start with an actionable diagnostic (FR-1.3).

## Troubleshooting

Bridge diagnostics are written to the OpenCode server log and to plugin storage key `apple-fm.diagnostic`. Cooldown state is in `~/.cache/opencode/apple-fm-state.json` and storage key `apple-fm.state`.

- `apple_intelligence_disabled` → System Settings > Apple Intelligence & Siri.
- `model_not_ready` → assets still downloading; wait and restart OpenCode.
- `binary not found` → run `npm run build:swift` (or `APPLE_FM_BRIDGE_PATH`).
- Stuck in cooldown → `/pcc-status` to inspect, `/pcc-status --lock-local` to force on-device, or delete `apple-fm-state.json` to reset.
