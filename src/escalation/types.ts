/**
 * The vocabulary for bringing a person into a running automation.
 *
 * An escalation is a request, not an error. Automation describes where it is,
 * why it stopped and what it needed, then waits. A person answers with one of a
 * small, closed set of resolutions — and only the resolutions that make sense
 * for the reason are offered, so "approve" never appears for a crash and
 * "resume" never appears for an irreversible step awaiting a decision.
 */

import type { LocatorEvidence } from "../locator/match.js";
import type { Action, ObservedElement } from "../perception/types.js";
import type { PolicyDecision } from "../policy/types.js";
import type { LeaseTransition } from "../session/lease.js";

export const RESOLUTION_KINDS = ["approve", "reject", "resume", "completed_manually", "abort"] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

export interface Resolution {
  /**
   * approve             perform the gated irreversible action
   * reject              do not perform it
   * resume              the person fixed the screen; automation retries the step
   * completed_manually  the person did the step themselves; automation moves on
   * abort               stop the run
   */
  readonly kind: ResolutionKind;
  /** Values the person read off the screen, for a read step they completed by hand. */
  readonly outputs?: Readonly<Record<string, string>>;
}

export type ReasonKind = "confirmation_required" | "replay_failure" | "agent_escalated" | "agent_stuck";

export interface EscalationReason {
  readonly kind: ReasonKind;
  /** Machine-readable cause: a failure kind, a policy rule, and so on. */
  readonly code: string;
  readonly detail: string;
}

export interface EscalationRequest {
  readonly mode: "discovery" | "replay";
  readonly runId: string;
  readonly capabilityId: string | null;
  readonly goal: string | null;
  readonly stepIndex: number | null;
  readonly stepIntent: string | null;
  readonly reason: EscalationReason;
  /** What automation needed to be true. */
  readonly expected: string | null;
  /** What was on screen when it stopped, redacted. */
  readonly observed: string;
  readonly allowed: readonly ResolutionKind[];
}

/** One thing a person did to the live session through the operator console. */
export interface OperatorAction {
  readonly at: string;
  readonly operator: string;
  readonly action: Action;
  /** The element as observed when they acted — enough to replay it as a recorded step. */
  readonly target: ObservedElement | null;
  readonly locatorEvidence: readonly LocatorEvidence[];
  readonly policy: PolicyDecision;
  readonly ok: boolean;
  readonly error?: string;
  readonly text?: string;
  readonly urlAfter: string;
}

export interface StateSnapshot {
  readonly at: string;
  readonly url: string;
  readonly title: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

/** The full record of one handoff, persisted as evidence. */
export interface Intervention extends EscalationRequest {
  readonly id: string;
  status: "open" | "claimed" | "resolved";
  readonly createdAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  resolvedAt: string | null;
  resolution: Resolution | null;
  note: string | null;
  readonly screenshots: string[];
  readonly actions: OperatorAction[];
  /**
   * Navigations observed while a person held the session, whoever caused them.
   * Covers someone working directly in the browser window rather than through
   * the console, where individual clicks are not attributable.
   */
  readonly navigations: { readonly at: string; readonly url: string }[];
  stateBefore: StateSnapshot | null;
  stateAfter: StateSnapshot | null;
  readonly lease: LeaseTransition[];
}

export interface EscalationOutcome {
  readonly interventionId: string;
  readonly resolution: Resolution;
  readonly operator: string | null;
  readonly note: string;
  readonly actions: readonly OperatorAction[];
  readonly pausedMs: number;
}

/** What automation calls when it needs a person. Resolves when the person hands the session back. */
export type EscalationHandler = (request: EscalationRequest) => Promise<EscalationOutcome>;

/** A handoff as summarised in a run result. */
export interface InterventionRecord {
  readonly id: string;
  readonly reason: string;
  readonly reasonKind: ReasonKind;
  readonly stepIndex: number | null;
  readonly operator: string | null;
  readonly resolution: ResolutionKind;
  readonly note: string;
  readonly operatorActions: number;
  readonly pausedMs: number;
}

export function recordOf(outcome: EscalationOutcome, request: EscalationRequest): InterventionRecord {
  return {
    id: outcome.interventionId,
    reason: request.reason.code,
    reasonKind: request.reason.kind,
    stepIndex: request.stepIndex,
    operator: outcome.operator,
    resolution: outcome.resolution.kind,
    note: outcome.note,
    operatorActions: outcome.actions.length,
    pausedMs: outcome.pausedMs,
  };
}
