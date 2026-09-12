/**
 * The desktop seam.
 *
 * This is deliberately not implemented. The brief says a desktop surface may be
 * stubbed provided the seam is real, and building a UI Automation driver would
 * consume the time the load-bearing pieces need. What matters is that it can be
 * added without touching anything above the Surface interface — so this file
 * exists to prove that claim is testable rather than asserted, and to record
 * precisely what the work would be.
 *
 * Why the rest of the system would not change:
 *
 * Windows UI Automation and macOS AX expose the same three concepts the web
 * accessibility tree does — a control's role, its accessible name, and its
 * value. `ObservedElement` is written in exactly those terms, so a desktop
 * driver populates the same fields from `IUIAutomationElement` (via
 * `CurrentControlType`, `CurrentName`, and the Value pattern) or from
 * `AXUIElement` (`AXRole`, `AXTitle`, `AXValue`). The agent loop, the compiler,
 * and the replay engine never learn which one produced the Observation.
 *
 * What genuinely differs, and how each maps:
 *
 * - Frames have no desktop analogue. `framePath` generalises to a window and
 *   pane path — top-level window title, then nested pane identifiers — which is
 *   why the field is a string array rather than an iframe reference.
 * - Navigation is not URL-driven. A `navigate` action becomes "focus this
 *   window" or "open this menu path", so the artifact's entrypoint field is
 *   typed per surface kind rather than as a bare URL.
 * - Anchor text still applies, and matters more. Desktop forms label controls
 *   with adjacent static text far more often than they set an accessible name,
 *   so the anchored-relative strategy that the demo target forces us to build
 *   is the primary strategy on desktop, not the fallback.
 * - Screenshots are per-window rather than full-page.
 *
 * The honest limitation: UI Automation quality varies by toolkit. Win32 and
 * WinForms applications expose usable trees; some older custom-drawn controls
 * expose a single opaque pane, and for those the only remaining channel is
 * screenshot plus coordinates. That case would need a third Surface
 * implementation with a genuinely weaker locator story — coordinates relative
 * to a matched image anchor — and its artifacts would deserve a lower
 * confidence rating rather than being silently treated as equivalent.
 */

import type { Action, ActResult, Observation, Surface } from "./types.js";

export interface DesktopSurfaceOptions {
  /** Top-level window to attach to, matched on its accessible name. */
  readonly windowTitle: string;
  /** Platform backend. Determines which accessibility API is used. */
  readonly backend: "uia" | "ax";
}

export class DesktopSurfaceNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `DesktopSurface.${operation} is not implemented. This is a documented seam, ` +
        `not a defect: see the header of src/perception/desktop.ts for the mapping ` +
        `from UI Automation / AX onto the Surface contract.`,
    );
    this.name = "DesktopSurfaceNotImplementedError";
  }
}

/**
 * Satisfies the Surface contract structurally so the compiler proves the seam
 * holds. Every method throws; none of them lie about having succeeded.
 */
export class DesktopSurface implements Surface {
  constructor(private readonly options: DesktopSurfaceOptions) {}

  get target(): string {
    return `${this.options.backend}:${this.options.windowTitle}`;
  }

  observe(): Promise<Observation> {
    throw new DesktopSurfaceNotImplementedError("observe");
  }

  act(_action: Action): Promise<ActResult> {
    throw new DesktopSurfaceNotImplementedError("act");
  }

  screenshot(): Promise<Buffer> {
    throw new DesktopSurfaceNotImplementedError("screenshot");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
