/**
 * The handoff desk: where a paused run meets a person.
 *
 * It owns the three things that make a handoff real rather than a TODO:
 *
 *   routing    An intervention carries enough context to act on without
 *              reading logs — the capability or goal, the step, why it
 *              stopped, what was expected, what was on screen, a screenshot.
 *
 *   control    The lease is moved on the person's behalf, so automation is
 *              paused for as long as they hold the session and cannot resume
 *              until they hand it back.
 *
 *   record     Everything the person does through the desk is captured with
 *              the same target detail a recorded step has, alongside the state
 *              of the session before and after, and any navigation that
 *              happened while they held it.
 *
 * The desk acts on the same Surface automation was using. There is no second
 * browser and no fresh session: the cookies, the half-completed form and the
 * error on screen are exactly what the person is handed.
 */

import { join } from "node:path";

import type { EvidenceBus } from "../evidence/bus.js";
import { locatorEvidence } from "../locator/match.js";
import type { Action, FramePath, Observation, Surface } from "../perception/types.js";
import type { PolicyEngine } from "../policy/engine.js";
import { redactor } from "../policy/redactor.js";
import { LeasedSurface, type SessionLease } from "../session/lease.js";
import type {
  EscalationHandler,
  EscalationOutcome,
  Intervention,
  OperatorAction,
  Resolution,
  StateSnapshot,
} from "./types.js";

export class DeskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeskError";
  }
}

interface NavigationSource {
  onNavigate(listener: (url: string, framePath: FramePath) => void): () => void;
}

function reportsNavigation(surface: Surface): surface is Surface & NavigationSource {
  return typeof (surface as Partial<NavigationSource>).onNavigate === "function";
}

function snapshotOf(obs: Observation): StateSnapshot {
  return {
    at: new Date().toISOString(),
    url: obs.url,
    title: obs.title,
    fields: obs.elements
      .filter((e) => e.actionable && (e.role === "textbox" || e.role === "combobox") && e.value !== null)
      .map((e) => ({
        label: e.name !== "" ? e.name : (e.anchorText ?? e.hints.fieldName ?? "(unlabelled)"),
        value: e.hints.inputType === "password" ? (e.value === "" ? "" : "[REDACTED]") : (e.value ?? ""),
      })),
  };
}

export interface DeskOptions {
  /** The live surface automation is using. Not a copy. */
  readonly surface: Surface;
  readonly lease: SessionLease;
  readonly policy: PolicyEngine;
  readonly evidence: EvidenceBus;
  /** Resolve an intervention as abort if nobody finishes it in time. Omit to wait for a person indefinitely. */
  readonly timeoutMs?: number;
  readonly onRaised?: (intervention: Readonly<Intervention>) => void;
}

export interface InterventionSummary {
  readonly id: string;
  readonly status: Intervention["status"];
  readonly mode: Intervention["mode"];
  readonly reason: Intervention["reason"];
  readonly capabilityId: string | null;
  readonly stepIndex: number | null;
  readonly createdAt: string;
  readonly claimedBy: string | null;
}

export class HandoffDesk {
  readonly #o: DeskOptions;
  readonly #interventions = new Map<string, Intervention>();
  readonly #waiters = new Map<string, (outcome: EscalationOutcome) => void>();
  /** The last screen each operator was shown, so an action targets what they were looking at. */
  readonly #screens = new Map<string, Observation>();
  #active: Intervention | null = null;
  #sequence = 0;

  constructor(options: DeskOptions) {
    this.#o = options;
    options.lease.onTransition((transition) => {
      this.#active?.lease.push(transition);
      options.evidence.emit("escalation", `Session control: ${transition.from} -> ${transition.to}`, transition);
    });
  }

  /** The handler automation calls. Resolves when a person hands the session back. */
  readonly escalate: EscalationHandler = async (request) => {
    const { surface, lease, evidence, timeoutMs, onRaised } = this.#o;
    if (this.#active !== null) {
      throw new DeskError(409, `intervention ${this.#active.id} is already open for this session`);
    }

    const id = `int-${String(++this.#sequence).padStart(3, "0")}`;
    const raisedAt = Date.now();
    const intervention: Intervention = {
      ...request,
      id,
      status: "open",
      createdAt: new Date(raisedAt).toISOString(),
      claimedAt: null,
      claimedBy: null,
      resolvedAt: null,
      resolution: null,
      note: null,
      screenshots: [],
      actions: [],
      navigations: [],
      stateBefore: null,
      stateAfter: null,
      lease: [],
    };
    this.#active = intervention;

    // Captured while automation still holds the session, so the record shows
    // exactly what the person was handed.
    try {
      intervention.stateBefore = snapshotOf(await surface.observe());
    } catch {
      // A snapshot is evidence, not a precondition for asking for help.
    }
    try {
      intervention.screenshots.push(evidence.saveScreenshot(`${id}-handed-over`, await surface.screenshot()));
    } catch {
      // As above.
    }

    lease.requestHuman(`${request.reason.code}: ${request.reason.detail}`.slice(0, 300));
    // Published only now. Listed any earlier, a person could claim it while
    // automation still held the session, and the claim would be refused.
    this.#interventions.set(id, intervention);
    const stopWatching = reportsNavigation(surface)
      ? surface.onNavigate((url) => intervention.navigations.push({ at: new Date().toISOString(), url }))
      : () => {};

    this.#persist(intervention);
    evidence.emit("escalation", `Intervention ${id} raised: ${request.reason.code}`, {
      id,
      stepIndex: request.stepIndex,
      reason: request.reason,
      allowed: request.allowed,
    });
    onRaised?.(intervention);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await new Promise<EscalationOutcome>((resolve) => {
      this.#waiters.set(id, resolve);
      if (timeoutMs !== undefined) timer = setTimeout(() => this.#expire(id), timeoutMs);
    });
    if (timer !== undefined) clearTimeout(timer);
    stopWatching();

    // Between the person's release and this line, nobody may act on the session.
    lease.resumeAutomation(`automation resumes after ${id} (${outcome.resolution.kind})`);
    this.#active = null;
    this.#screens.delete(id);
    this.#persist(intervention);
    return { ...outcome, pausedMs: Date.now() - raisedAt };
  };

  list(): InterventionSummary[] {
    return [...this.#interventions.values()].reverse().map((i) => ({
      id: i.id,
      status: i.status,
      mode: i.mode,
      reason: i.reason,
      capabilityId: i.capabilityId,
      stepIndex: i.stepIndex,
      createdAt: i.createdAt,
      claimedBy: i.claimedBy,
    }));
  }

  get(id: string): Intervention {
    return this.#require(id);
  }

  /** Screenshots never change the session, so anyone may look before deciding to claim. */
  async screenshot(id: string): Promise<Buffer> {
    this.#require(id);
    return this.#o.surface.screenshot();
  }

  claim(id: string, operator: string): Intervention {
    const intervention = this.#require(id);
    if (intervention.status !== "open") throw new DeskError(409, `${id} is ${intervention.status}, not open`);
    this.#o.lease.claim(operator, `${operator} claimed ${id}`);
    intervention.status = "claimed";
    intervention.claimedAt = new Date().toISOString();
    intervention.claimedBy = operator;
    this.#persist(intervention);
    this.#o.evidence.emit("escalation", `${operator} took control for ${id}`, { id, operator });
    return intervention;
  }

  async observe(id: string, operator: string): Promise<Observation> {
    this.#requireClaim(id, operator);
    const screen = await this.#operatorSurface(operator).observe();
    this.#screens.set(id, screen);
    return screen;
  }

  async act(id: string, operator: string, action: Action): Promise<{ record: OperatorAction; screen: Observation }> {
    const intervention = this.#requireClaim(id, operator);
    const { policy, evidence } = this.#o;

    const screen = this.#screens.get(id);
    if (screen === undefined) {
      throw new DeskError(409, "Refresh the screen before acting, so the action targets what you are looking at.");
    }
    const target = "nodeId" in action ? screen.elements.find((e) => e.nodeId === action.nodeId) : undefined;
    if ("nodeId" in action && target === undefined) {
      throw new DeskError(409, `No control ${action.nodeId} on the current screen. Refresh and try again.`);
    }

    // The person is the decider for an irreversible step, so "confirm" does not
    // stop them. The allowlist still does, and a secret they type is still
    // registered for redaction by the same check automation goes through.
    const decision = policy.check(action, { mode: "discovery" }, target);
    if (decision.verdict === "deny") throw new DeskError(403, decision.reason);

    const surface = this.#operatorSurface(operator);
    const result = await surface.act(action);
    const after = await surface.observe();
    this.#screens.set(id, after);
    const where = policy.checkLocation(after.url);

    const error = result.error ?? (where.verdict === "allow" ? undefined : where.reason);
    const record: OperatorAction = {
      at: new Date().toISOString(),
      operator,
      action,
      target: target ?? null,
      locatorEvidence: target === undefined ? [] : locatorEvidence(target, screen.elements),
      policy: decision,
      ok: result.ok && where.verdict === "allow",
      ...(error === undefined ? {} : { error }),
      ...(result.text === undefined ? {} : { text: result.text }),
      urlAfter: after.url,
    };
    intervention.actions.push(record);
    this.#persist(intervention);

    const label = target === undefined ? "" : ` on ${target.name !== "" ? target.name : (target.anchorText ?? target.role)}`;
    evidence.emit("escalation", `Operator ${operator}: ${action.kind}${label}`, { id, action, ok: record.ok, risk: decision.verdict });
    return { record, screen: after };
  }

  async resolve(id: string, operator: string, resolution: Resolution, note: string): Promise<Intervention> {
    const intervention = this.#requireClaim(id, operator);
    const { lease, evidence } = this.#o;

    if (!intervention.allowed.includes(resolution.kind)) {
      throw new DeskError(
        400,
        `'${resolution.kind}' does not resolve a ${intervention.reason.kind}; choose one of: ${intervention.allowed.join(", ")}`,
      );
    }

    const surface = this.#operatorSurface(operator);
    try {
      intervention.stateAfter = snapshotOf(await surface.observe());
    } catch {
      // Evidence only.
    }
    try {
      intervention.screenshots.push(evidence.saveScreenshot(`${id}-handed-back`, await surface.screenshot()));
    } catch {
      // Evidence only.
    }

    lease.release(operator, `${operator} resolved ${id}: ${resolution.kind}`);
    intervention.status = "resolved";
    intervention.resolvedAt = new Date().toISOString();
    intervention.resolution = resolution;
    intervention.note = redactor.redactText(note).slice(0, 2000);
    this.#persist(intervention);
    evidence.emit("escalation", `${id} resolved by ${operator}: ${resolution.kind}`, { id, resolution: resolution.kind, note: intervention.note });

    this.#settle(id, {
      interventionId: id,
      resolution,
      operator,
      note: intervention.note,
      actions: [...intervention.actions],
      pausedMs: 0,
    });
    return intervention;
  }

  #expire(id: string): void {
    const intervention = this.#interventions.get(id);
    if (intervention === undefined || intervention.status === "resolved") return;
    const { lease, evidence } = this.#o;

    if (intervention.status === "open") lease.withdraw(`${id} was not claimed in time`);
    else lease.revoke(`${id} was not resolved in time`);

    intervention.status = "resolved";
    intervention.resolvedAt = new Date().toISOString();
    intervention.resolution = { kind: "abort" };
    intervention.note = "Timed out waiting for a person.";
    this.#persist(intervention);
    evidence.emit("escalation", `${id} timed out`, { id });

    this.#settle(id, {
      interventionId: id,
      resolution: { kind: "abort" },
      operator: intervention.claimedBy,
      note: intervention.note,
      actions: [...intervention.actions],
      pausedMs: 0,
    });
  }

  #settle(id: string, outcome: EscalationOutcome): void {
    const resolve = this.#waiters.get(id);
    this.#waiters.delete(id);
    resolve?.(outcome);
  }

  #operatorSurface(operator: string): LeasedSurface {
    return new LeasedSurface(this.#o.surface, this.#o.lease, { kind: "operator", id: operator });
  }

  #require(id: string): Intervention {
    const intervention = this.#interventions.get(id);
    if (intervention === undefined) throw new DeskError(404, `no intervention ${id}`);
    return intervention;
  }

  #requireClaim(id: string, operator: string): Intervention {
    const intervention = this.#require(id);
    if (intervention.status !== "claimed") throw new DeskError(409, `${id} is ${intervention.status}; claim it first`);
    if (intervention.claimedBy !== operator) {
      throw new DeskError(403, `${id} is claimed by ${intervention.claimedBy ?? "nobody"}, not ${operator}`);
    }
    return intervention;
  }

  #persist(intervention: Intervention): void {
    this.#o.evidence.writeJson(join("interventions", `${intervention.id}.json`), intervention);
  }
}
