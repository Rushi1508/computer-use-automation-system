/**
 * Fault injection for the demo surface.
 *
 * Why a control endpoint rather than query parameters: a recorded capability
 * artifact captures the URLs the agent actually visited. If faults were armed
 * via `?fail=timeout`, that scaffolding would be baked into the artifact and
 * replayed forever. Server-side arming keeps the app's URLs honest, so an
 * artifact recorded against a healthy app is the same artifact replayed
 * against a faulting one — which is exactly the comparison the evidence needs
 * to demonstrate.
 *
 * Scope note: these are *runtime* faults only — transient slowness, surprise
 * interstitials, session expiry, outright errors. Business outcomes ("no such
 * member", "not authorized") are driven by the data instead, because in a real
 * institution they are legitimate answers rather than injected failures. That
 * split is the error taxonomy made physical.
 */

export const FAULT_KINDS = ["slow_load", "interstitial", "session_expired", "server_error"] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export function isFaultKind(value: string): value is FaultKind {
  return (FAULT_KINDS as readonly string[]).includes(value);
}

interface ArmedFault {
  readonly kind: FaultKind;
  /** Only fire on request paths starting with this. Empty string matches all. */
  readonly pathPrefix: string;
  /** Remaining firings. Decremented on each match; the fault clears at zero. */
  remaining: number;
  /** Delay in ms, used by slow_load. */
  readonly delayMs: number;
}

let armed: ArmedFault | null = null;

export interface ArmOptions {
  kind: FaultKind;
  pathPrefix?: string;
  times?: number;
  delayMs?: number;
}

export function armFault(options: ArmOptions): ArmedFault {
  armed = {
    kind: options.kind,
    pathPrefix: options.pathPrefix ?? "",
    remaining: options.times ?? 1,
    delayMs: options.delayMs ?? 6000,
  };
  return armed;
}

export function clearFaults(): void {
  armed = null;
}

export function peekFault(): Readonly<ArmedFault> | null {
  return armed;
}

/**
 * Returns the fault that should fire for this request, consuming one firing.
 * Returns null when nothing is armed or the path does not match.
 */
export function consumeFault(path: string): Readonly<ArmedFault> | null {
  if (armed === null) return null;
  if (armed.pathPrefix !== "" && !path.startsWith(armed.pathPrefix)) return null;

  const firing = { ...armed };
  armed.remaining -= 1;
  if (armed.remaining <= 0) armed = null;
  return firing;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
