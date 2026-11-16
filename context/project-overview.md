# Project Overview

- What: OpenCode provider plugin routing inference to Apple's on-device Foundation Models (`FoundationModels` / `SystemLanguageModel`) via a local Swift bridge — zero API cost, zero prompt egress.
- State: Prototype / pre-release (v0.1.0). Core lifecycle, streaming, tool calling, and diagnostics working; PCC follow-up not yet merged (see build-plan).
- Users: Software engineers using OpenCode on Apple Silicon Macs who want private, free, offline-capable coding assistance for routine tasks (explanations, tests, commit messages, small refactors).
- In scope: OpenCode plugin (TypeScript/Bun) lifecycle + provider registration; Swift bridge (`apple-fm-bridge`) exposing OpenAI-compatible `/v1/chat/completions` (SSE + JSON) on 127.0.0.1 with per-session bearer token; health/availability checks, context-window guardrail, hybrid fallback routing.
- Out of scope: Cloud LLM hosting, PCC forced routing (Apple exposes no developer flag — all inference is on-device, `X-Apple-Compute-Target: on-device`), non-macOS / Intel support, telemetry/analytics.
- Goals: $0 inference; TTFT <400ms on M1+; 100% automatic context guardrail; loopback-only isolation; no prompt logging.
- Non-goals: Frontier-scale reasoning (delegated to optional hybrid fallback); full App Store signing/notarization pipeline (manual `APPLE_FM_SIGN_IDENTITY` only).
- Glossary: FoundationModels: Apple Swift framework exposing `SystemLanguageModel`; PCC: Private Cloud Compute (OS-level routing, not developer-addressable); Bridge: Swift daemon bridging Swift-only API to Bun/TypeScript runtime.
- Open questions: PRD defines PCC cooldown/countdown UX (`~/.cache/opencode/apple-fm-state.json`, `/pcc-status`) — adapter needed given Apple has no developer PCC flag; context limit is 4096 tokens locally vs 8k+ assumed in PRD; Gatekeeper notarization flow for npm distribution.
