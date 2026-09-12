/**
 * A client for the operator console API.
 *
 * Used by the scripted operator in the evidence scenarios and by the tests. It
 * speaks only to the HTTP API a person's console page uses, so anything the
 * scripted operator can do, a person can do, and nothing more.
 */

import type { Action } from "../perception/types.js";
import type { ControlView, ScreenView } from "./operator-server.js";
import type { Resolution } from "./types.js";

export interface InterventionListing {
  readonly id: string;
  readonly status: "open" | "claimed" | "resolved";
  readonly reason: { readonly kind: string; readonly code: string; readonly detail: string };
  readonly stepIndex: number | null;
}

export interface ActResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly text?: string;
  readonly risk: string;
  readonly screen: ScreenView;
}

export class OperatorClient {
  constructor(
    private readonly baseUrl: string,
    readonly operator: string,
  ) {}

  async #call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operator: this.operator, ...body }),
          }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(`${response.status} ${data.error ?? response.statusText}`);
    return data as T;
  }

  lease(): Promise<{ state: string; holder: { kind: string; id: string } | null; generation: number }> {
    return this.#call("/api/lease");
  }

  interventions(): Promise<InterventionListing[]> {
    return this.#call("/api/interventions");
  }

  intervention(id: string): Promise<Record<string, unknown>> {
    return this.#call(`/api/interventions/${encodeURIComponent(id)}`);
  }

  /** Waits for the next open intervention to appear in the queue. */
  async waitForOpen(timeoutMs = 60_000): Promise<InterventionListing> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const open = (await this.interventions()).find((i) => i.status === "open");
      if (open !== undefined) return open;
      if (Date.now() > deadline) throw new Error("no intervention was raised in time");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  claim(id: string): Promise<Record<string, unknown>> {
    return this.#call(`/api/interventions/${encodeURIComponent(id)}/claim`, {});
  }

  observe(id: string): Promise<ScreenView> {
    return this.#call(
      `/api/interventions/${encodeURIComponent(id)}/observation?operator=${encodeURIComponent(this.operator)}`,
    );
  }

  /** Re-observes until the screen satisfies a condition, for pages still loading after an action. */
  async observeUntil(id: string, ready: (screen: ScreenView) => boolean, timeoutMs = 10_000): Promise<ScreenView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.observe(id);
      if (ready(screen)) return screen;
      if (Date.now() > deadline) throw new Error(`screen did not become ready: ${screen.title} ${screen.url}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  act(id: string, action: Action): Promise<ActResponse> {
    return this.#call(`/api/interventions/${encodeURIComponent(id)}/act`, { action });
  }

  resolve(id: string, resolution: Resolution, note: string): Promise<Record<string, unknown>> {
    return this.#call(`/api/interventions/${encodeURIComponent(id)}/resolve`, { resolution, note });
  }
}

export interface ControlQuery {
  readonly name?: string;
  readonly anchorText?: string;
  readonly role?: string;
  readonly frame?: string;
  readonly actionable?: boolean;
}

export function matchesControl(control: ControlView, query: ControlQuery): boolean {
  return (
    (query.name === undefined || control.name === query.name) &&
    (query.anchorText === undefined || control.anchorText === query.anchorText) &&
    (query.role === undefined || control.role === query.role) &&
    (query.frame === undefined || control.frame === query.frame) &&
    (query.actionable === undefined || control.actionable === query.actionable)
  );
}

/** Finds exactly one control, as a careful person would: an ambiguous match is an error, not a guess. */
export function findControl(screen: ScreenView, query: ControlQuery): ControlView {
  const matches = screen.controls.filter((c) => matchesControl(c, query));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`expected one control matching ${JSON.stringify(query)}, found ${matches.length}`);
  }
  return matches[0];
}
