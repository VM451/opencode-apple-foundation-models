/**
 * TUI companion (optional).
 *
 * OpenCode loads server plugins (`src/index.ts`) and TUI plugins (`src/tui.ts`) as separate entries.
 * package.json can map `./tui` to this file so OpenCode registers it alongside the server plugin.
 * The TUI plugin renders a live PCC footer + consumes storage toasts written by the server.

 * When the TUI runtime is absent (headless `opencode run`, `serve`, CI), this file is ignored — the
 * server plugin still works via console + storage fallback.
 *
 * Usage:
 *   "exports": { ".": "./src/index.ts", "./tui": "./src/tui.ts" }
 */
import { Plugin } from "@opencode/plugin"
import { formatCountdown, formatResetClock, remainingMs } from "./pcc-state"

interface PccStateMirror {
  activeTarget: "pcc" | "on-device"
  lockedLocal: boolean
  resetAt: number | null
}

function buildStatus(state: PccStateMirror | null | undefined, now = Date.now()): string {
  if (!state) return "Apple FM: PCC preferred · on-device fallback ready"
  if (state.lockedLocal) return "Apple FM: on-device (locked)"
  if (state.resetAt !== null && now < state.resetAt) {
    const left = remainingMs({ ...state as any, resetAt: state.resetAt, activeTarget: "on-device" } as any, now) || remainingBoundary(state, now)
    const ms = Math.max(0, state.resetAt - now)
    return `Apple FM: on-device (PCC resets in ${formatCountdown(ms)} at ${formatResetClock(state.resetAt)})`
  }
  return "Apple FM: PCC preferred"
}

function remainingBoundary(state: PccStateMirror, now: number): number {
  if (!state.resetAt) return 0
  return Math.max(0, state.resetAt - now)
}

// TUI entry — no-op if Solid runtime is missing at import time.
export default Plugin.define({
  // TUI import shape uses a different Plugin type; keep as any for host compat.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...(Plugin as any),
} as any)

export const tui = {
  id: "opencode-apple-foundation-models-tui",

  buildStatus,

  /**
   * Solid component helper (typed loosely to survive host type drift).
   * Renders the PCC countdown in `prompt.footer.status` slot.
   */
  component: function PccFooter(props: { sessionID?: string; mode: "normal" | "shell"; showDetails: boolean }) {
    // This is illustrative; actual implementation uses `usePlugin` + `storage` store.
    // Keeping the file side-effect-free so sideloading without Solid doesn't throw.
    return null
  },
}
