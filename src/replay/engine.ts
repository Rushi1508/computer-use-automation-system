/**
 * Deterministic replay: the production execution path.
 *
 * No model is consulted. A capability runs as recorded, on a fresh session,
 * and every unexpected screen is sorted into exactly one of three vocabularies —
 * keeping them apart is the point of the whole result contract:
 *
 *   business outcome   A legitimate answer ("no such member"). Returned to the
 *                      caller as a result, never as an error.
 *   recoverable        A condition replay can fix and continue past: a
 *                      maintenance notice, an expired session, a slow render.
 *                      Handled with bounded attempts, and recorded.
 *   failure            Anything else. Stops the run with the step, what was
 *                      expected, what was actually on screen, and a screenshot.
 *
 * When an escalation handler is supplied, two things change and nothing else
 * does. A failure a person could fix is offered to a person before it ends the
 * run, and an irreversible step in an unapproved capability waits for a
 * person's decision instead of being refused outright. Either way the person
 * works on this same session, and replay picks up from where they leave it —
 * re-locating its target first, because a person's view of the screen is not
 * automation's.
 *
 * Determinism comes mostly from what replay refuses to do. It never guesses
 * between two matching elements, never sleeps a fixed time and hopes, never
 * retries an irreversible step, never re-runs a flow past an irreversible step
 * to recover a session, and never treats "the click succeeded" as evidence that
 * the application did what was intended.
 *
 * It depends only on the Surface interface and on Observations, so it runs
 * unchanged against any surface that produces them.
 */

import type { EvidenceBus } from "../evidence/bus.js";
import {
  type EscalationHandler,
  type EscalationOutcome,
  type EscalationReason,
  type InterventionRecord,
  recordOf,
  type ResolutionKind,
} from "../escalation/types.js";
import { detectorHolds, resolveTarget, screenText } from "../locator/match.js";
import type { Action, Observation, ObservedElement, Surface } from "../perception/types.js";
import { type ConfirmHandler, denyByDefault } from "../policy/confirm.js";
import type { PolicyEngine } from "../policy/engine.js";
import { redactor } from "../policy/redactor.js";
import type { PolicyDecision } from "../policy/types.js";
import { type AppProfile, appProfile } from "../schema/app-profile.js";
import type { Capability, Detector, Step, Strategy, Target } from "../schema/capability.js";

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_MAX_ESCALATIONS = 3;
/** A wait for a target longer than this is recorded as an absorbed transient load. */
const SLOW_RENDER_THRESHOLD_MS = 1_500;

// --- Result contract --------------------------------------------------------

export type FailureKind =
  | "invalid_input"
  | "policy_denied"
  | "confirmation_refused"
  | "target_not_found"
  | "action_failed"
  | "checkpoint_failed"
  | "output_empty"
  | "application_error"
  | "recovery_exhausted"
  | "unsafe_to_recover"
  | "operator_aborted";

export interface ReplayFailure {
  readonly kind: FailureKind;
  readonly stepIndex: number | null;
  readonly stepIntent: string | null;
  /** What replay needed to be true. */
  readonly expected: string;
  /** What was actually on screen, redacted. */
  readonly observed: string;
  /**
   * Whether a person taking over the live session could plausibly finish.
   * False for things a person should not override — a policy denial, a
   * malformed invocation, a decision a person already made.
   */
  readonly escalatable: boolean;
  readonly evidence: { readonly screenshot?: string; readonly tree?: string };
}

export interface StepRecord {
  readonly index: number;
  readonly action: Step["action"];
  readonly intent: string;
  readonly durationMs: number;
  readonly polls: number;
  readonly resolvedBy?: {
    readonly kind: Strategy["kind"];
    readonly rank: number;
    readonly confidence: number;
  };
  /** True when the step ran as part of recovering an expired session. */
  readonly reauthentication: boolean;
  /** An operator may complete a step by hand during a handoff. The record says so. */
  readonly completedBy: "automation" | "operator";
}

export interface RecoveryRecord {
  readonly id: string;
  readonly atStep: number | null;
  readonly remedy: "click" | "wait" | "reauthenticate" | "bounded_wait";
  readonly attempt: number;
  readonly detail: string;
}

/**
 * A step resolved by a lower-ranked strategy than the recorded best. Not an
 * error — the step ran correctly — but the cheapest early warning available
 * that the application has changed under a capability.
 */
export interface DriftRecord {
  readonly stepIndex: number;
  readonly target: string;
  readonly resolvedBy: Strategy["kind"];
  readonly rank: number;
  readonly bypassed: readonly {
    readonly kind: Strategy["kind"];
    readonly outcome: "no_match" | "ambiguous";
    readonly matches: number;
  }[];
}

interface RunSummary {
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly runId: string;
  readonly entrypoint: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly steps: readonly StepRecord[];
  readonly recoveries: readonly RecoveryRecord[];
  readonly drift: readonly DriftRecord[];
  readonly interventions: readonly InterventionRecord[];
}

type Terminal =
  | { readonly status: "succeeded"; readonly outputs: Readonly<Record<string, string>> }
  | {
      readonly status: "business_outcome";
      readonly outcome: { readonly code: string; readonly description: string };
      readonly atStep: number | null;
    }
  | { readonly status: "failed"; readonly failure: ReplayFailure };

export type ReplayResult = Terminal & RunSummary;

/** Process exit code for a result: success, a legitimate answer, or a failure. */
export function exitCodeFor(result: ReplayResult): number {
  return result.status === "succeeded" ? 0 : result.status === "business_outcome" ? 2 : 1;
}

export interface ReplayOptions {
  readonly capability: Capability;
  readonly inputs: Readonly<Record<string, string>>;
  readonly surface: Surface;
  readonly policy: PolicyEngine;
  readonly evidence: EvidenceBus;
  /**
   * Binds the capability to an environment. The recorded entrypoint belongs to
   * wherever discovery ran; the same capability runs against another tenant's
   * instance, or a test server, by supplying that instance's URL here.
   */
  readonly entrypoint?: string;
  /** Used for irreversible steps when no escalation handler is present. */
  readonly onConfirm?: ConfirmHandler;
  /** Brings a person into the run for fixable failures and irreversible steps. */
  readonly escalation?: EscalationHandler;
  /** Upper bound on handoffs per run, so a flow that keeps breaking stops asking. */
  readonly maxEscalations?: number;
  readonly stepTimeoutMs?: number;
  readonly pollMs?: number;
  readonly profile?: AppProfile;
}

/** Checks invocation arguments against the capability's declared inputs. */
export function validateInputs(
  capability: Capability,
  inputs: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const declared = new Set(capability.inputs.map((i) => i.name));

  for (const input of capability.inputs) {
    const value = inputs[input.name];
    if (value === undefined || value === "") {
      if (input.required) problems.push(`missing required input '${input.name}'`);
      continue;
    }
    if (input.type === "number" && !Number.isFinite(Number(value))) {
      problems.push(`input '${input.name}' must be a number`);
    }
    if (input.type === "boolean" && value !== "true" && value !== "false") {
      problems.push(`input '${input.name}' must be true or false`);
    }
  }
  for (const key of Object.keys(inputs)) {
    if (!declared.has(key)) problems.push(`unknown input '${key}'`);
  }
  return problems;
}

// --- Engine -----------------------------------------------------------------

/** Ends the run with a terminal result. */
class Halt extends Error {
  constructor(readonly terminal: Extract<Terminal, { readonly status: "business_outcome" | "failed" }>) {
    super(terminal.status);
  }
}

/** Resumes the step loop at a given index, after re-authentication. */
class Restart extends Error {
  constructor(readonly resumeAt: number) {
    super(`restart at step ${resumeAt}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(obs: Observation | null): string {
  if (obs === null) return "no observation was available";
  const text = screenText(obs)
    .replace(/^\s*-\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  const warnings = obs.warnings.length > 0 ? ` | warnings: ${obs.warnings.join("; ")}` : "";
  return `title "${obs.title}" at ${obs.url} showing: ${clipped}${warnings}`;
}

interface Config {
  readonly capability: Capability;
  readonly inputs: Readonly<Record<string, string>>;
  readonly surface: Surface;
  readonly policy: PolicyEngine;
  readonly evidence: EvidenceBus;
  readonly entrypoint: string;
  readonly onConfirm: ConfirmHandler;
  readonly escalation: EscalationHandler | undefined;
  readonly maxEscalations: number;
  readonly stepTimeoutMs: number;
  readonly pollMs: number;
  readonly profile: AppProfile;
}

interface Located {
  readonly element: ObservedElement;
  readonly polls: number;
  readonly resolvedBy: NonNullable<StepRecord["resolvedBy"]>;
}

class ReplayRun {
  readonly #c: Config;
  readonly #started = Date.now();
  readonly #steps: StepRecord[] = [];
  readonly #recoveries: RecoveryRecord[] = [];
  readonly #drift: DriftRecord[] = [];
  readonly #interventions: InterventionRecord[] = [];
  readonly #outputs: Record<string, string> = {};
  readonly #attempts = new Map<string, number>();
  #riskyExecuted = false;
  #reauthenticating = false;
  #escalations = 0;
  #last: Observation | null = null;

  constructor(config: Config) {
    this.#c = config;
  }

  async run(): Promise<ReplayResult> {
    const { capability, inputs, evidence } = this.#c;

    evidence.emit("run.start", `Replay of ${capability.id} v${capability.version}`, {
      entrypoint: this.#c.entrypoint,
      approvalState: capability.approvalState,
      escalation: this.#c.escalation !== undefined,
      inputs: Object.fromEntries(
        capability.inputs.map((i) => [i.name, i.sensitivity === "secret" ? "[secret]" : (inputs[i.name] ?? null)]),
      ),
    });

    // Validated before the surface is touched: a malformed invocation is the
    // caller's error and should cost nothing to report.
    const problems = validateInputs(capability, inputs);
    if (problems.length > 0) {
      return this.#finish({
        status: "failed",
        failure: {
          kind: "invalid_input",
          stepIndex: null,
          stepIntent: null,
          expected: "inputs that satisfy the capability's declared contract",
          observed: problems.join("; "),
          escalatable: false,
          evidence: {},
        },
      });
    }

    for (const input of capability.inputs) {
      const value = inputs[input.name];
      if (input.sensitivity === "secret" && value !== undefined) redactor.registerSecret(value);
    }

    try {
      await this.#navigateEntrypoint(null);

      let index = 0;
      while (index < capability.steps.length) {
        const step = capability.steps[index];
        if (step === undefined) break;
        try {
          await this.#execute(step);
          index++;
        } catch (error) {
          if (error instanceof Restart) {
            index = error.resumeAt;
            continue;
          }
          const next = await this.#handOff(error, step);
          if (next === "retry") continue;
          if (next === "advance") {
            index++;
            continue;
          }
          throw error;
        }
      }

      for (;;) {
        try {
          await this.#verifySuccess();
          break;
        } catch (error) {
          const next = await this.#handOff(error, null);
          if (next === "retry") continue;
          if (next === "advance") break;
          throw error;
        }
      }

      const missing = capability.outputs.filter((o) => (this.#outputs[o.name] ?? "") === "");
      if (missing.length > 0) {
        throw await this.#fail("output_empty", null, `values for ${missing.map((o) => o.name).join(", ")}`, true);
      }

      return this.#finish({ status: "succeeded", outputs: { ...this.#outputs } });
    } catch (error) {
      if (error instanceof Halt) return this.#finish(error.terminal);
      // Anything unanticipated still becomes a structured, debuggable failure.
      // A replay that throws is a replay the calling agent cannot reason about.
      const message = error instanceof Error ? error.message : String(error);
      const failure = await this.#buildFailure("action_failed", null, "the replay to complete", true, `unexpected error: ${message}`);
      return this.#finish({ status: "failed", failure });
    }
  }

  async #navigateEntrypoint(step: Step | null): Promise<void> {
    const { policy, surface, evidence, entrypoint } = this.#c;
    const decision = policy.checkLocation(entrypoint);
    evidence.emit("policy.decision", `Entrypoint ${decision.verdict}`, decision);
    if (decision.verdict !== "allow") {
      throw await this.#fail("policy_denied", step, `permission to open ${entrypoint}`, false, decision.reason);
    }
    const result = await surface.act({ kind: "navigate", url: entrypoint });
    if (!result.ok) {
      throw await this.#fail("action_failed", step, `${entrypoint} to load`, true, result.error ?? "navigation failed");
    }
  }

  async #execute(step: Step): Promise<void> {
    const { capability, surface, policy, evidence } = this.#c;
    const began = Date.now();
    evidence.emit("action.start", `Step ${step.index}: ${step.action}`, {
      intent: step.intent,
      target: step.target?.description,
      reauthentication: this.#reauthenticating,
    });

    if (step.action === "navigate") {
      const url = step.url ?? "";
      const decision = policy.checkLocation(url);
      if (decision.verdict !== "allow") {
        throw await this.#fail("policy_denied", step, `permission to open ${url}`, false, decision.reason);
      }
      const result = await surface.act({ kind: "navigate", url });
      if (!result.ok) throw await this.#fail("action_failed", step, `${url} to load`, true, result.error ?? "navigation failed");
      this.#record(step, began, 0);
      return;
    }

    if (step.action === "wait") {
      await sleep(step.waitMs);
      this.#record(step, began, 0);
      return;
    }

    const target = step.target;
    if (target === undefined) {
      throw await this.#fail("action_failed", step, "a target for this step", false, "the artifact step has no target");
    }

    let located = await this.#locate(step, target);
    let action = this.#action(step, located.element);

    const decision = policy.check(
      action,
      { mode: "replay", declaredRisk: step.risk, capabilityApproved: capability.approvalState === "approved" },
      located.element,
    );
    evidence.emit("policy.decision", `${step.action}: ${decision.verdict}`, { rule: decision.rule, reason: decision.reason });

    if (decision.verdict === "deny") {
      throw await this.#fail("policy_denied", step, `permission to ${step.action} ${target.description}`, false, decision.reason);
    }
    if (decision.verdict === "confirm") {
      const involvedPerson = await this.#confirm(step, target, decision, action, located.element);
      if (involvedPerson) {
        // The person may have looked at or changed the screen, which
        // invalidates node ids. Find the target again before acting on it.
        located = await this.#locate(step, target);
        action = this.#action(step, located.element);
      }
    }

    let result = await surface.act(action);
    // An element can be re-rendered between observing it and acting on it.
    // Re-locate and retry once — but only for a reversible step. An
    // irreversible action that reported failure may still have taken effect,
    // and repeating it is the one mistake replay must never make.
    if (!result.ok && step.risk === "safe_reversible") {
      evidence.emit("recovery", `Step ${step.index}: action failed, re-locating once`, { error: result.error });
      located = await this.#locate(step, target);
      action = this.#action(step, located.element);
      result = await surface.act(action);
    }
    if (!result.ok) {
      throw await this.#fail("action_failed", step, `${step.action} on ${target.description} to succeed`, true, result.error ?? "unknown error");
    }
    if (step.risk === "risky_irreversible") this.#riskyExecuted = true;

    // A click can land somewhere the allowlist forbids.
    const after = await surface.observe();
    this.#last = after;
    const where = policy.checkLocation(after.url);
    if (where.verdict !== "allow") {
      throw await this.#fail("policy_denied", step, "to remain within the allowlist", false, where.reason);
    }

    if (step.action === "read") {
      const value = result.text ?? "";
      if (step.outputName !== undefined) {
        this.#outputs[step.outputName] = value;
        evidence.emit("extraction", `Read ${step.outputName}`, { value });
      }
      if (value === "") throw await this.#fail("output_empty", step, `a value for ${step.outputName ?? "this read"}`, true);
    }

    if (step.checkpoint !== undefined) {
      const reached = await this.#waitFor(step, step.checkpoint.detector);
      if (!reached) throw await this.#fail("checkpoint_failed", step, step.checkpoint.description, true);
      evidence.emit("checkpoint", `Checkpoint after step ${step.index} verified`, step.checkpoint.detector);
    }

    this.#record(step, began, located.polls, located.resolvedBy);
  }

  /**
   * Gets a decision on an irreversible step.
   *
   * Returns true when a person was involved, which means the screen has to be
   * looked at again before acting. Throws when the answer is no.
   */
  async #confirm(
    step: Step,
    target: Target,
    decision: PolicyDecision,
    action: Action,
    element: ObservedElement,
  ): Promise<boolean> {
    const { escalation, onConfirm, evidence } = this.#c;

    if (escalation === undefined) {
      const granted = await onConfirm(decision, action, element);
      evidence.emit("policy.decision", `Confirmation ${granted ? "granted" : "refused"}`, { rule: decision.rule });
      if (!granted) {
        throw await this.#fail("confirmation_refused", step, `a person to approve: ${decision.reason}`, true, "confirmation was not granted");
      }
      return false;
    }

    const outcome = await this.#raise(
      step,
      { kind: "confirmation_required", code: decision.rule, detail: decision.reason },
      `approval to ${step.action} ${target.description}`,
      ["approve", "reject", "abort"],
    );
    if (outcome.resolution.kind === "approve") return true;

    // A person made this decision; it is not something to escalate again.
    const who = `operator ${outcome.operator ?? "unknown"}`;
    const note = outcome.note !== "" ? outcome.note : "no note";
    const aborted = outcome.resolution.kind === "abort";
    throw await this.#fail(
      aborted ? "operator_aborted" : "confirmation_refused",
      step,
      `a person to approve: ${decision.reason}`,
      false,
      aborted ? `stopped by ${who}: ${note}` : `refused by ${who}: ${note}`,
    );
  }

  /**
   * Offers a failure to a person, when one is available and it is a failure a
   * person could fix. Returns what the step loop should do next.
   */
  async #handOff(error: unknown, step: Step | null): Promise<"retry" | "advance" | "none"> {
    if (!(error instanceof Halt)) return "none";
    const terminal = error.terminal;
    if (terminal.status !== "failed") return "none";
    const failure = terminal.failure;
    const { escalation, maxEscalations } = this.#c;
    if (escalation === undefined || !failure.escalatable || this.#escalations >= maxEscalations) return "none";

    const outcome = await this.#raise(
      step,
      { kind: "replay_failure", code: failure.kind, detail: failure.observed },
      failure.expected,
      ["resume", "completed_manually", "abort"],
    );

    switch (outcome.resolution.kind) {
      case "resume":
        return "retry";

      case "completed_manually": {
        if (step !== null) {
          const provided = step.outputName === undefined ? undefined : outcome.resolution.outputs?.[step.outputName];
          if (step.outputName !== undefined && provided !== undefined) this.#outputs[step.outputName] = provided;
          if (step.risk === "risky_irreversible") this.#riskyExecuted = true;
          this.#record(step, Date.now(), 0, undefined, "operator");
        }
        return "advance";
      }

      default:
        throw new Halt({
          status: "failed",
          failure: {
            ...failure,
            kind: "operator_aborted",
            escalatable: false,
            observed: redactor.redactText(
              `stopped by operator ${outcome.operator ?? "unknown"}: ${outcome.note !== "" ? outcome.note : "no note"} | ` +
                `original failure ${failure.kind}: ${failure.observed}`,
            ),
          },
        });
    }
  }

  /** Pauses for a person and records the handoff. */
  async #raise(
    step: Step | null,
    reason: EscalationReason,
    expected: string,
    allowed: readonly ResolutionKind[],
  ): Promise<EscalationOutcome> {
    const { escalation, capability, evidence } = this.#c;
    if (escalation === undefined) throw new Error("no escalation handler is configured");

    this.#escalations++;
    const request = {
      mode: "replay" as const,
      runId: evidence.runId,
      capabilityId: capability.id,
      goal: capability.description,
      stepIndex: step === null ? null : step.index,
      stepIntent: step === null ? null : step.intent,
      reason,
      expected,
      observed: redactor.redactText(summarize(this.#last)),
      allowed,
    };
    evidence.emit("escalation", `Pausing for a person: ${reason.code}`, { stepIndex: request.stepIndex, reason, allowed });

    const outcome = await escalation(request);
    this.#interventions.push(recordOf(outcome, request));

    // Whatever the person did happened outside this run's view. If any of it
    // looked irreversible, treat the session as past an irreversible step, so a
    // later session expiry is never "recovered" by replaying over their work.
    if (outcome.actions.some((a) => a.ok && a.policy.verdict === "confirm")) this.#riskyExecuted = true;
    this.#last = null;

    evidence.emit("escalation", `Resumed after ${outcome.interventionId}: ${outcome.resolution.kind}`, {
      operator: outcome.operator,
      note: outcome.note,
      operatorActions: outcome.actions.length,
      pausedMs: outcome.pausedMs,
    });
    return outcome;
  }

  /**
   * Finds a step's target, waiting for it with a bounded poll.
   *
   * Each poll checks, in order: business outcomes (the application answered),
   * fatal conditions (waiting cannot help), the target itself, and finally
   * recoverable conditions. Outcomes come first because an answer screen is
   * never something to wait past or remedy.
   */
  async #locate(step: Step, target: Target): Promise<Located> {
    const { surface, stepTimeoutMs, pollMs, evidence } = this.#c;
    const began = Date.now();
    const deadline = began + stepTimeoutMs;
    let polls = 0;

    for (;;) {
      const obs = await surface.observe();
      this.#last = obs;
      this.#checkOutcomes(obs, step);
      await this.#checkFatal(obs, step);

      const resolution = resolveTarget(target, obs.elements);
      const rank = resolution.winnerRank;
      const winner = rank === null ? undefined : target.strategies[rank];

      if (resolution.element !== null && rank !== null && winner !== undefined) {
        const waited = Date.now() - began;
        // Only a wait that included at least one unsuccessful look counts. The
        // cost of a single observation is replay's own overhead, not the
        // application being slow, and recording it as a recovery would put a
        // false claim into the evidence.
        if (polls > 0 && waited >= SLOW_RENDER_THRESHOLD_MS) {
          const record: RecoveryRecord = {
            id: "transient_slow_render",
            atStep: step.index,
            remedy: "bounded_wait",
            attempt: 1,
            detail: `waited ${waited}ms for ${target.description} to render`,
          };
          this.#recoveries.push(record);
          evidence.emit("recovery", record.detail, record);
        }

        if (rank > 0) {
          const drift: DriftRecord = {
            stepIndex: step.index,
            target: target.description,
            resolvedBy: winner.strategy.kind,
            rank,
            bypassed: resolution.attempts.flatMap((a) =>
              a.outcome === "resolved" ? [] : [{ kind: a.kind, outcome: a.outcome, matches: a.matches }],
            ),
          };
          this.#drift.push(drift);
          evidence.emit("drift", `Step ${step.index} resolved by fallback strategy ${winner.strategy.kind}`, drift);
        }

        return {
          element: resolution.element,
          polls,
          resolvedBy: { kind: winner.strategy.kind, rank, confidence: winner.confidence },
        };
      }

      if (await this.#tryRecover(obs, step)) continue;

      if (Date.now() >= deadline) {
        const tried = resolution.attempts
          .map((a) => `${a.kind} ${a.outcome.replace("_", " ")}${a.outcome === "ambiguous" ? ` (${a.matches} matches)` : ""}`)
          .join("; ");
        throw await this.#fail("target_not_found", step, `${target.description} [${tried}]`, true);
      }

      polls++;
      await sleep(pollMs);
    }
  }

  #checkOutcomes(obs: Observation, step: Step | null): void {
    for (const outcome of this.#c.capability.knownOutcomes) {
      if (!outcome.terminal || !detectorHolds(outcome.detector, obs)) continue;
      const atStep = step === null ? null : step.index;
      this.#c.evidence.emit("outcome", `Business outcome ${outcome.code}`, { code: outcome.code, atStep });
      throw new Halt({
        status: "business_outcome",
        outcome: { code: outcome.code, description: outcome.description },
        atStep,
      });
    }
  }

  async #checkFatal(obs: Observation, step: Step | null): Promise<void> {
    for (const condition of this.#c.profile.fatalConditions) {
      if (!detectorHolds(condition.detector, obs)) continue;
      throw await this.#fail(
        "application_error",
        step,
        "the application to respond normally",
        true,
        `${condition.id}: ${condition.description}`,
      );
    }
  }

  /** Applies at most one matching recoverable. Returns true when it did. */
  async #tryRecover(obs: Observation, step: Step): Promise<boolean> {
    const { profile, capability, surface, policy, evidence } = this.#c;

    for (const recoverable of profile.recoverables) {
      if (!detectorHolds(recoverable.detector, obs)) continue;

      const attempt = (this.#attempts.get(recoverable.id) ?? 0) + 1;
      if (attempt > recoverable.maxAttempts) {
        throw await this.#fail(
          "recovery_exhausted",
          step,
          `${recoverable.id} to clear`,
          true,
          `still present after ${recoverable.maxAttempts} attempt(s)`,
        );
      }
      this.#attempts.set(recoverable.id, attempt);

      const remedy = recoverable.remedy;
      const note = (kind: RecoveryRecord["remedy"], detail: string): void => {
        const record: RecoveryRecord = { id: recoverable.id, atStep: step.index, remedy: kind, attempt, detail };
        this.#recoveries.push(record);
        evidence.emit("recovery", `${recoverable.id}: ${detail}`, record);
      };

      switch (remedy.kind) {
        case "click": {
          // Interstitials can appear in any frame, so the remedy searches all of them.
          const resolution = resolveTarget(remedy.target, obs.elements, { anyFrame: true });
          if (resolution.element === null) {
            throw await this.#fail(
              "recovery_exhausted",
              step,
              `${remedy.target.description} to dismiss ${recoverable.id}`,
              true,
              "the remedy's control was not on screen",
            );
          }
          const action: Action = { kind: "click", nodeId: resolution.element.nodeId };
          const decision = policy.check(action, { mode: "replay", declaredRisk: "safe_reversible" }, resolution.element);
          if (decision.verdict !== "allow") {
            throw await this.#fail("policy_denied", step, `permission to dismiss ${recoverable.id}`, false, decision.reason);
          }
          const result = await surface.act(action);
          if (!result.ok) {
            throw await this.#fail("recovery_exhausted", step, `${recoverable.id} to be dismissed`, true, result.error ?? "click failed");
          }
          note("click", `clicked ${remedy.target.description}`);
          return true;
        }

        case "wait":
          await sleep(remedy.ms);
          note("wait", `waited ${remedy.ms}ms`);
          return true;

        case "reauthenticate": {
          const auth = capability.authentication;
          if (auth === undefined) {
            throw await this.#fail("recovery_exhausted", step, "to re-establish the session", true, "the capability declares no authentication steps to re-run");
          }
          if (this.#riskyExecuted) {
            throw await this.#fail(
              "unsafe_to_recover",
              step,
              "to re-establish the session",
              true,
              "an irreversible step has already run in this session; re-running the flow could repeat it, so a person must decide",
            );
          }
          if (this.#reauthenticating) {
            throw await this.#fail("recovery_exhausted", step, "a stable session", true, "the session expired again while re-authenticating");
          }

          note("reauthenticate", `re-running authentication steps 0-${auth.throughStep}, then resuming at step ${auth.throughStep + 1}`);
          this.#reauthenticating = true;
          try {
            await this.#navigateEntrypoint(step);
            for (let i = 0; i <= auth.throughStep; i++) {
              const authStep = capability.steps[i];
              if (authStep !== undefined) await this.#execute(authStep);
            }
          } finally {
            this.#reauthenticating = false;
          }
          throw new Restart(auth.throughStep + 1);
        }
      }
    }
    return false;
  }

  async #waitFor(step: Step | null, detector: Detector): Promise<boolean> {
    const { surface, stepTimeoutMs, pollMs } = this.#c;
    const deadline = Date.now() + stepTimeoutMs;
    for (;;) {
      const obs = await surface.observe();
      this.#last = obs;
      this.#checkOutcomes(obs, step);
      await this.#checkFatal(obs, step);
      if (detectorHolds(detector, obs)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  async #verifySuccess(): Promise<void> {
    const { successCheckpoint } = this.#c.capability;
    const reached = await this.#waitFor(null, successCheckpoint.detector);
    if (!reached) throw await this.#fail("checkpoint_failed", null, successCheckpoint.description, true);
    this.#c.evidence.emit("checkpoint", "Success checkpoint verified", successCheckpoint.detector);
  }

  #action(step: Step, element: ObservedElement): Action {
    switch (step.action) {
      case "click":
        return { kind: "click", nodeId: element.nodeId };
      case "fill":
        return { kind: "fill", nodeId: element.nodeId, value: this.#value(step) };
      case "select":
        return { kind: "select", nodeId: element.nodeId, value: this.#value(step) };
      case "read":
        return { kind: "read", nodeId: element.nodeId };
      case "navigate":
      case "wait":
        throw new Error(`step ${step.index}: '${step.action}' does not act on a target`);
    }
  }

  #value(step: Step): string {
    const ref = step.value;
    if (ref === undefined) return "";
    return "param" in ref ? (this.#c.inputs[ref.param] ?? "") : ref.literal;
  }

  #record(
    step: Step,
    began: number,
    polls: number,
    resolvedBy?: StepRecord["resolvedBy"],
    completedBy: StepRecord["completedBy"] = "automation",
  ): void {
    this.#steps.push({
      index: step.index,
      action: step.action,
      intent: step.intent,
      durationMs: Date.now() - began,
      polls,
      ...(resolvedBy === undefined ? {} : { resolvedBy }),
      reauthentication: this.#reauthenticating,
      completedBy,
    });
  }

  async #fail(
    kind: FailureKind,
    step: Step | null,
    expected: string,
    escalatable: boolean,
    detail?: string,
  ): Promise<Halt> {
    return new Halt({ status: "failed", failure: await this.#buildFailure(kind, step, expected, escalatable, detail) });
  }

  async #buildFailure(
    kind: FailureKind,
    step: Step | null,
    expected: string,
    escalatable: boolean,
    detail?: string,
  ): Promise<ReplayFailure> {
    const { surface, evidence } = this.#c;
    try {
      this.#last = await surface.observe();
    } catch {
      // Keep the last good observation; a failure report must not itself fail.
    }

    const screen = summarize(this.#last);
    const observed = redactor.redactText(detail === undefined ? screen : `${detail} | ${screen}`);
    const tag = `failure-step-${step === null ? "none" : step.index}`;

    const saved: { screenshot?: string; tree?: string } = {};
    try {
      saved.screenshot = evidence.saveScreenshot(tag, await surface.screenshot());
    } catch {
      // Evidence is best effort; the structured failure is not.
    }
    if (this.#last !== null) saved.tree = evidence.saveSnapshot(`${tag}-tree`, this.#last.tree);

    const failure: ReplayFailure = {
      kind,
      stepIndex: step === null ? null : step.index,
      stepIntent: step === null ? null : step.intent,
      expected,
      observed,
      escalatable,
      evidence: saved,
    };
    evidence.emit("error", `Replay failed: ${kind}`, failure);
    return failure;
  }

  #finish(terminal: Terminal): ReplayResult {
    const { capability, evidence } = this.#c;
    const result: ReplayResult = {
      ...terminal,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      runId: evidence.runId,
      entrypoint: this.#c.entrypoint,
      startedAt: new Date(this.#started).toISOString(),
      elapsedMs: Date.now() - this.#started,
      steps: this.#steps,
      recoveries: this.#recoveries,
      drift: this.#drift,
      interventions: this.#interventions,
    };
    evidence.emit("run.end", `Replay ${result.status}`, {
      status: result.status,
      steps: this.#steps.length,
      recoveries: this.#recoveries.length,
      drift: this.#drift.length,
      interventions: this.#interventions.length,
    });
    evidence.writeResult(result);
    return result;
  }
}

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const run = new ReplayRun({
    capability: options.capability,
    inputs: options.inputs,
    surface: options.surface,
    policy: options.policy,
    evidence: options.evidence,
    entrypoint: options.entrypoint ?? options.capability.surface.entrypoint,
    onConfirm: options.onConfirm ?? denyByDefault,
    escalation: options.escalation,
    maxEscalations: options.maxEscalations ?? DEFAULT_MAX_ESCALATIONS,
    stepTimeoutMs: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    profile: options.profile ?? appProfile(options.capability.surface.appProfileId),
  });
  return run.run();
}
