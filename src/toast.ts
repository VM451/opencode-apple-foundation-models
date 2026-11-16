/**
 * Toast helper (PRD §5.3 FR-3.3).
 * Server plugins in OpenCode v2 don't have direct `ui.toast` access.
 * This tries the runtime's client (TUI) when present, then falls back to
 * storage + console so the state is never silently lost.
 */

import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface ToastOptions {
  title?: string
  message: string
  variant?: ToastVariant
  duration?: number
}

export async function showToast(
  ctx: { storage?: { set: (k: string, v: any) => Promise<void> }; client?: any } | any,
  opts: ToastOptions,
): Promise<void> {
  const message = opts.message
  const variant = opts.variant ?? "info"
  const title = opts.title

  // 1) Direct TUI client if runtime exposes it (custom / desktop / injected)
  const candidates = [
    (ctx as any)?.client?.tui?.showToast,
    (ctx as any)?.client?.tui?.toast?.show,
    (ctx as any)?.tui?.showToast,
    (ctx as any)?.ui?.toast?.show,
    (ctx as any)?.client?.toast?.show,
  ]
  for (const fn of candidates) {
    if (typeof fn === "function") {
      try {
        // Best-effort: try both signatures
        await fn.call(ctx, title ? { title, message, variant } : { message, variant })
        return
      } catch {
        // fall through
      }
      try {
        await fn.call(ctx, message, variant)
        return
      } catch {
        // fall through
      }
    }
  }

  // 2) Event bridge: some runtimes expose event publish
  if (typeof (ctx as any)?.event?.publish === "function") {
    try {
      await (ctx as any).event.publish({
        type: "tui.toast.show",
        data: { title: title ?? "", message, variant, duration: opts.duration ?? 8000 },
      })
      return
    } catch {}
  }

  // 3) Durable fallback: storage key consumed by the TUI companion (src/tui.ts)
  if (ctx?.storage?.set) {
    try {
      await ctx.storage.set("apple-fm.toast", {
        title: title ?? "Apple FM",
        message,
        variant,
        duration: opts.duration ?? 8000,
        at: Date.now(),
      })
      // also keep a readable log
      await ctx.storage.set("apple-fm.toast.last", { message, variant, at: Date.now() })
    } catch {}
  }

  // 4) Console (visible in server logs; reliable even when TUI absent)
  const prefix = `[apple-fm:${variant}]`
  if (title) console.warn(`${prefix} ${title}: ${message}`)
  else console.warn(`${prefix} ${message}`)
}
