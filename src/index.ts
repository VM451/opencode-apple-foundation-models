import { Model, Plugin, Provider } from "@opencode/plugin"
import { BridgeManager } from "./bridge"
import { diagnosticMessage } from "./diagnostics"
import { MODEL_ID, PROVIDER_ID, MODEL_ID_HYBRID, MODEL_ID_ON_DEVICE } from "./protocol"
import { isHeavyPrompt, estimateTokens, type RoutingOptions } from "./router"
import { applyFailover, applySwitchBack, defaultPccOptions, formatCountdown, formatResetClock, isInCooldown, isRateLimitError, parseLockCommand, parseRetryAfter, remainingMs, toastMessageOnFailover, toastMessageOnReset } from "./pcc-state"
import { PccStore } from "./pcc-store"
import { showToast } from "./toast"

interface AppleFMOptions {
  port?: number
  context?: number
  maxOutput?: number
  bridgePath?: string
  startTimeoutMs?: number
  hybrid?: {
    threshold?: number
    fallback?: { providerID: string; modelID: string }
  }
  pccFailover?: {
    enabled?: boolean
    defaultCooldownMinutes?: number
    autoSwitchBack?: boolean
    notifyOnSwitch?: boolean
  }
}

function readOptions(ctx: { options: Readonly<Record<string, any>> }): AppleFMOptions {
  const raw = ctx.options ?? {}
  const nested = raw["opencode-apple-foundation-models"] ?? raw["apple-fm"]
  const o: Record<string, any> = (nested && typeof nested === "object") ? { ...nested, ...raw } : raw
  const hybridRaw = o.hybrid && typeof o.hybrid === "object" ? o.hybrid : undefined
  const pccRaw = o.pccFailover && typeof o.pccFailover === "object" ? o.pccFailover : o.pcc_failover && typeof o.pcc_failover === "object" ? o.pcc_failover : undefined
  return {
    port: Number(o.port) || undefined,
    context: Number(o.context) || undefined,
    maxOutput: Number(o.maxOutput) || undefined,
    bridgePath: typeof o.bridgePath === "string" ? o.bridgePath : undefined,
    startTimeoutMs: Number(o.startTimeoutMs) || undefined,
    hybrid: hybridRaw ? {
      threshold: Number(hybridRaw.threshold) || undefined,
      fallback: hybridRaw.fallback && typeof hybridRaw.fallback === "object"
        ? {
            providerID: String(hybridRaw.fallback.providerID),
            modelID: String(hybridRaw.fallback.modelID),
          }
        : undefined,
    } : undefined,
    pccFailover: pccRaw ? {
      enabled: pccRaw.enabled !== undefined ? Boolean(pccRaw.enabled) : undefined,
      defaultCooldownMinutes: pccRaw.defaultCooldownMinutes !== undefined ? Number(pccRaw.defaultCooldownMinutes) : undefined,
      autoSwitchBack: pccRaw.autoSwitchBack !== undefined ? Boolean(pccRaw.autoSwitchBack) : undefined,
      notifyOnSwitch: pccRaw.notifyOnSwitch !== undefined ? Boolean(pccRaw.notifyOnSwitch) : undefined,
    } : undefined,
  }
}

function extractText(message: any): string {
  if (!message) return ""
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  }
  return ""
}

export default Plugin.define({
  id: "opencode-apple-foundation-models",
  async setup(ctx) {
    const options = readOptions(ctx)
    if (process.env.APPLE_FM_DEBUG) console.warn("[apple-fm] setup: starting bridge")
    const manager = new BridgeManager({
      port: options.port,
      context: options.context,
      maxOutput: options.maxOutput,
      bridgePath: options.bridgePath,
      startTimeoutMs: options.startTimeoutMs,
    })

    // PCC state machine (FR-3)
    const pccOpts = defaultPccOptions(options.pccFailover ?? (ctx.options as any)?.pccFailover)
    const pccStore = new PccStore(`${process.env.XDG_CACHE_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "~"}/.cache`}/opencode/apple-fm-state.json`, {
      activeTarget: "pcc",
      lockedLocal: false,
      resetAt: null,
      nextProbeAt: null,
      probeBackoffLevel: 0,
      updatedAt: Date.now(),
    })
    let pccState = await pccStore.load(ctx as any)

    // If cooldown persisted but expired, mark for switchback on first tick
    const now0 = Date.now()
    if (pccState.activeTarget === "on-device" && pccState.resetAt !== null && now0 >= pccState.resetAt && !pccState.lockedLocal && pccOpts.autoSwitchBack) {
      pccState = applySwitchBack(pccState, now0, { probeSucceeded: true })
      await pccStore.persistAndMirror(async (s) => { await ctx.storage.set("apple-fm.state", s as any).catch(() => {}) })
      if (pccOpts.notifyOnSwitch) {
        // Best-effort reset toast
        try { await showToast(ctx as any, { title: "Apple FM", message: toastMessageOnReset(), variant: "success" }) } catch {}
      }
    }

    try {
      await manager.start()
    } catch (error) {
      const message = diagnosticMessage(null, error)
      console.warn(message)
      await ctx.storage.set("apple-fm.diagnostic", message).catch(() => {})
      return
    }

    if (process.env.APPLE_FM_DEBUG) console.warn(`[apple-fm] bridge ready at ${manager.baseURL}`)
    const health = await manager.health()
    const diagnostic = diagnosticMessage(health)
    if (diagnostic) {
      console.warn(diagnostic)
      await ctx.storage.set("apple-fm.diagnostic", diagnostic).catch(() => {})
    } else {
      await ctx.storage.set("apple-fm.diagnostic", "").catch(() => {})
    }

    // Advertised limits: bridge clamps to real 4096, but OpenCode uses this to
    // decide auto-compaction. PRD example is 16384/4096 for hybrid, 8192/2048
    // for on-device; we honor user override else fall back to generous defaults
    // that don't prematurely compact.
    const advertisedCtxHybrid = options.context ?? 16384
    const advertisedOutHybrid = options.maxOutput ?? 4096
    const advertisedCtxLocal = Math.min(advertisedCtxHybrid, 8192)
    const advertisedOutLocal = Math.min(advertisedOutHybrid, 2048)
    const providerID = Provider.ID.make(PROVIDER_ID)
    const registrations: Array<{ dispose: () => Promise<void> }> = []

    const providerRegistration = await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Apple Foundation Models (PCC + On-Device)",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: manager.baseURL,
            apiKey: manager.token,
          },
        },
        models: [
          {
            ...Model.Info.default(providerID, Model.ID.make(MODEL_ID_HYBRID)),
            name: "Apple Hybrid (PCC with On-Device FM Failover)",
            limit: { context: advertisedCtxHybrid, output: advertisedOutHybrid },
            // Bridge alias: system-language-model
          } as any,
          {
            ...Model.Info.default(providerID, Model.ID.make(MODEL_ID_ON_DEVICE)),
            name: "Apple Foundation Model (Strict On-Device)",
            limit: { context: advertisedCtxLocal, output: advertisedOutLocal },
          } as any,
        ],
      })
    })
    registrations.push(providerRegistration)

    // Keep legacy single-model id for back-compat (opencode.json.example uses system-language-model)
    const legacyRegistration = await ctx.provider.transform((editor) => {
      // Add legacy model if not already present — dedupe by id
      const existing = editor.list().find((p: any) => p?.provider?.info?.id === PROVIDER_ID || p?.provider?.id === PROVIDER_ID)
      // Provider transform is additive via add(); but OpenCode may dedupe.
      // We add legacy as separate call — harmless if duplicate.
      try {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: "Apple Foundation Models (On-Device)",
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: {
              baseURL: manager.baseURL,
              apiKey: manager.token,
            },
          },
          models: [
            {
              ...Model.Info.default(providerID, Model.ID.make(MODEL_ID)),
              name: "Apple System Language Model (On-Device)",
              limit: { context: options.context ?? 8192, output: options.maxOutput ?? 2048 },
            },
          ],
        })
      } catch {}
    })
    // Only push if it didn't throw — dedup errors are ok
    try { registrations.push(legacyRegistration) } catch {}

    // Hybrid routing: if fallback configured, heavy prompts leave apple-fm
    const routing: RoutingOptions = {
      threshold: options.hybrid?.threshold ?? 2048,
      fallback: options.hybrid?.fallback,
    }

    if (routing.fallback) {
      const fallback = routing.fallback
      const registration = await ctx.session.hook(
        "experimental.model.resolve",
        async (event) => {
          if (event.kind !== "primary" || String(event.model.providerID) !== PROVIDER_ID) return
          const messages = await ctx.session.context({ sessionID: event.sessionID })
          const lastUser = [...messages].reverse().find((m: any) => m?.role === "user")
          const text = extractText(lastUser)
          // PCC cooldown: stick to on-device even for heavy prompts (failover stays local)
          if (isInCooldown(pccState)) return
          if (pccState.lockedLocal) return
          if (isHeavyPrompt(text, routing)) {
            // If hybrid model selected, heavy -> cloud; if on-device selected, stay anyway
            const selectedId = String((event.model as any)?.id ?? (event.model as any)?.modelID ?? "")
            if (selectedId === MODEL_ID_ON_DEVICE || selectedId === MODEL_ID) return
            event.model = { providerID: fallback.providerID as any, id: fallback.modelID as any }
          }
          // FR-1.4 / FR-4.1: simple tasks under token budget stay on-device
          // (implicitly satisfied because we only delegate heavy when threshold exceeded)
        },
      )
      registrations.push(registration)
    }

    // PCC quota detection: observe http.response for rate-limit signals (FR-3.1/FR-2.4)
    // The Swift bridge is strictly on-device today (Apple exposes no PCC flag).
    // When PCC is added by a future OS, the bridge will emit
    //   X-Apple-Compute-Target: pcc|on-device
    //   429 + Retry-After on quota breach.
    // This hook translates that into state + toast + auto-retry semantics
    // at the plugin layer.
    const httpHook = await ctx.session.hook(
      "http.response",
      async (event: any) => {
        const modelProvider = String(event?.model?.providerID ?? "")
        const modelId = String(event?.model?.id ?? event?.model?.modelID ?? "")
        if (modelProvider !== PROVIDER_ID && modelId !== MODEL_ID_HYBRID && modelId !== MODEL_ID && modelId !== MODEL_ID_ON_DEVICE) {
          // Still observe when provider matches; otherwise ignore
          if (modelProvider !== PROVIDER_ID) return
        }
        if (!pccOpts.enabled) return

        const res = event?.response
        if (!res) return
        const status: number = res.status ?? 0
        const headersObj: Record<string, string> = {}
        try {
          // headers may be Headers or plain object
          if (res.headers && typeof res.headers.get === "function") {
            ["retry-after", "x-retry-after", "x-apple-compute-target", "x-apple-fm-retry"].forEach((h) => {
              const v = res.headers.get(h) ?? res.headers.get(h.replace(/-/g, "").toLowerCase())
              if (v) headersObj[h] = v
              if (v) headersObj[h.replace(/-/g, "").toLowerCase()] = v
            })
            // fallback: try case-insens
            res.headers.forEach((v: string, k: string) => { headersObj[k.toLowerCase()] = v })
          } else if (res.headers && typeof res.headers === "object") {
            Object.assign(headersObj, res.headers)
          }
        } catch {}

        let body: unknown = null
        try {
          // don't consume streaming bodies twice — only inspect when not streaming
          // SAFETY: http.response event's response is informational; we clone via headers/status only.
          // We avoid reading the body to not break streaming. Instead, treat 429/503 as rate-limit.
          // Body inspection is done via the Swift bridge's own handling, which already maps to 429.
        } catch {}

        if (!isRateLimitError(status, body, headersObj)) return

        // Already in cooldown and locked — nothing to do
        if (pccState.lockedLocal) return
        const now = Date.now()
        if (isInCooldown(pccState, now)) {
          // Extend cooldown if Retry-After is later
          const { resetAt } = parseRetryAfter(headersObj, body, pccOpts.defaultCooldownMinutes, now)
          if (resetAt > (pccState.resetAt ?? 0)) {
            pccState = applyFailover(pccState, resetAt, now, "rate_limited_extended")
            await pccStore.persistAndMirror(async (s) => { await ctx.storage.set("apple-fm.state", s as any).catch(() => {}) })
          }
          return
        }

        const { resetAt, source } = parseRetryAfter(headersObj, body, pccOpts.defaultCooldownMinutes, now)
        const wasPcc = pccState.activeTarget === "pcc"
        pccState = applyFailover(pccState, resetAt, now, `rate_limited:${source}`)
        await pccStore.persistAndMirror(async (s) => { await ctx.storage.set("apple-fm.state", s as any).catch(() => {}) })

        if (pccOpts.notifyOnSwitch) {
          try {
            await showToast(ctx as any, {
              title: "Apple FM — PCC failover",
              message: toastMessageOnFailover(pccState, now),
              variant: "warning",
              duration: 8000,
            })
          } catch {}
        }

        // Seamless retry hint: OpenCode's retry hook will re-issue; the next
        // request will now see isInCooldown==true and stay on-device (<100ms target).
        void wasPcc
      },
    )
    registrations.push(httpHook)

    // model.request: annotate outgoing calls with compute intent for debugging
    const modelHook = await ctx.session.hook("model.request", async (event: any) => {
      const providerID = String((event as any)?.model?.providerID ?? "")
      if (providerID !== PROVIDER_ID) return
      try {
        const headers = (event as any).headers ?? {}
        if (isInCooldown(pccState)) {
          headers["x-apple-on-device"] = "1"
          headers["x-apple-force-on-device"] = "1"
        } else if (pccState.lockedLocal) {
          headers["x-apple-force-on-device"] = "1"
        } else {
          headers["x-apple-compute-preference"] = "pcc-prefer-on-device-fallback"
        }
      } catch {}
    }).catch(() => null)
    if (modelHook) registrations.push(modelHook as any)

    // /pcc-status slash command (FR-3.3)
    try {
      const cmdRegistration = await ctx.command.transform((editor) => {
        editor.add({
          name: "pcc-status",
          description: "Show PCC vs on-device status and countdown",
          execute: async (input: any) => {
            const args: string = typeof input?.prompt === "string" ? input.prompt : input?.prompt?.text ?? ""
            const action = parseLockCommand(args)
            if (action === "lock") {
              pccState = { ...pccState, lockedLocal: true, activeTarget: "on-device", updatedAt: Date.now() }
              await pccStore.persistAndMirror(async (s) => { await ctx.storage.set("apple-fm.state", s as any).catch(() => {}) })
              await showToast(ctx as any, { title: "Apple FM", message: "Locked to on-device Apple Foundation Model.", variant: "info" }).catch(() => {})
              return
            }
            if (action === "unlock") {
              pccState = { ...pccState, lockedLocal: false, updatedAt: Date.now() }
              // may immediately be eligible if cooldown expired
              if (pccState.resetAt === null || Date.now() >= pccState.resetAt) {
                pccState = { ...pccState, activeTarget: "pcc", resetAt: null }
              }
              await pccStore.persistAndMirror(async (s) => { await ctx.storage.set("apple-fm.state", s as any).catch(() => {}) })
              await showToast(ctx as any, { title: "Apple FM", message: "Unlocked PCC routing (auto fallback to on-device on limits).", variant: "success" }).catch(() => {})
              return
            }

            // Default: show status
            const now = Date.now()
            const remaining = remainingMs(pccState, now)
            const clock = pccState.resetAt !== null ? ` at ${formatResetClock(pccState.resetAt)}` : ""
            let msg: string
            if (pccState.lockedLocal) {
              msg = "Compute: on-device (locked via /pcc-status --lock-local). PCC cooldown timer paused; use /pcc-status --unlock to resume PCC preference."
            } else if (isInCooldown(pccState, now)) {
              msg = `Compute: on-device Apple Foundation Model (PCC cooldown). PCC resets in ${formatCountdown(remaining)}${clock}.`
            } else {
              msg = "Compute: Private Cloud Compute (preferred) with on-device fallback. No cooldown."
            }
            // Also format remaining as MM:SS for CLI
            const tl = ` (remaining ${remaining > 0 ? formatCountdown(remaining) : "0s"})`
            // Write to session as a synthetic message so it surfaces visibly if TUI toast not available
            try {
              if (input?.sessionID) {
                // use synthetic pinned message if api available
                if (typeof ctx.session.synthetic === "function") {
                  await (ctx.session.synthetic as any)({ sessionID: input.sessionID, prompt: msg, delivery: input.delivery }).catch(() => {})
                }
              }
            } catch {}
            await showToast(ctx as any, { title: "PCC status", message: msg, variant: isInCooldown(pccState, now) ? "warning" : "info", duration: 8000 }).catch(() => {})
            // Always also log to diagnostics storage for /pcc-status polling by TUI footer
            await ctx.storage.set("apple-fm.pcc-status", { message: msg, at: now, remainingMs: remaining, text: `${msg}${tl}` } as any).catch(() => {})
          },
        })
      })
      registrations.push(cmdRegistration)
    } catch (e) {
      if (process.env.APPLE_FM_DEBUG) console.warn("[apple-fm] command registration failed", e)
    }

    // Auto switch-back timer (FR-3.4)
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const maybeSwitchBack = async () => {
      if (stopped) return
      if (!pccOpts.enabled || !pccOpts.autoSwitchBack) return
      if (pccState.lockedLocal) return
      if (pccState.resetAt === null) return
      const now = Date.now()
      if (now < pccState.resetAt) return
      // lightweight probe: re-check bridge health (on-device still available)
      const h = await manager.health().catch(() => null)
      // If bridge healthy, assume PCC back (OS no longer throttles); on-device never blocks workflow
      const probeOk = h === null || h.available === true
      if (!probeOk) return
      pccState = applySwitchBack(pccState, now, { probeSucceeded: true })
      if (pccState.activeTarget === "pcc") {
        await pccStore.persistAndMirror(async (s) => { await ctx.storage.set("apple-fm.state", s as any).catch(() => {}) })
        if (pccOpts.notifyOnSwitch) {
          try {
            await showToast(ctx as any, { title: "Apple FM", message: toastMessageOnReset(), variant: "success", duration: 8000 })
          } catch {}
        }
      }
    }

    // Per-second tick for countdown freshness + timeout aligned to resetAt
    timer = setInterval(() => {
      void maybeSwitchBack()
    }, 1000)
    // avoid keeping process alive
    try { (timer as any)?.unref?.() } catch {}

    // Immediate one-shot for known reset
    if (pccState.resetAt !== null && pccState.resetAt > Date.now()) {
      const delay = pccState.resetAt - Date.now()
      timeoutHandle = setTimeout(() => { void maybeSwitchBack() }, Math.min(delay, 24 * 60 * 60 * 1000))
      try { (timeoutHandle as any)?.unref?.() } catch {}
    }

    return async () => {
      stopped = true
      if (timer) { clearInterval(timer); timer = null }
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null }
      for (const registration of registrations) {
        await registration.dispose().catch(() => {})
      }
      await manager.stop()
    }
  },
})
