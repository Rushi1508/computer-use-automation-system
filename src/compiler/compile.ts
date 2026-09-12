/**
 * Compiling a discovery trace into a capability artifact.
 *
 * This is a compilation, not a transcript dump. The trace is a record of what
 * one exploration did with one set of literal values; the artifact is a
 * reusable contract. Three transformations do the real work:
 *
 *   parameterisation   Literal values the run typed become named, typed inputs.
 *                      The literal never enters the artifact, which is what
 *                      makes "no secrets or PII in artifacts" structural rather
 *                      than a filter someone has to remember to run.
 *
 *   target derivation  Each per-observation node id becomes a ranked set of
 *                      durable strategies with recorded reasoning.
 *
 *   outcome merge      The application's known business outcomes and recovery
 *                      rules are merged in from its profile, because a happy
 *                      path run could not have learned them.
 *
 * Everything here is deterministic. No model is consulted, so recompiling the
 * same trace always yields the same artifact and a reviewer can reason about
 * why a given step looks the way it does.
 */

import type { DiscoveryResult, TraceStep } from "../agent/loop.js";
import type { ObservedElement } from "../perception/types.js";
import { appProfile } from "../schema/app-profile.js";
import {
  type Capability,
  CapabilitySchema,
  type CapabilityInput,
  type CapabilityOutput,
  type Detector,
  type Step,
  type ValueRef,
} from "../schema/capability.js";
import { redactor } from "../policy/redactor.js";
import { deriveTarget } from "./strategies.js";

/**
 * Scrubs recorded secret literals from every free-text field in an artifact.
 *
 * Parameterising a step removes the value from the step, but free text carries
 * values too: an operator who phrases a goal as "sign on with password hunter2"
 * puts that credential into provenance, and a model's step intent can echo a
 * value it just typed. Since the compiler knows exactly which literals became
 * secret parameters, it can remove those specific strings rather than relying
 * on the redactor having been primed by an earlier code path.
 *
 * Both layers run: the known literals, then the general redactor for patterns
 * this compilation never saw.
 */
function scrubFreeText<T>(value: T, secretLiterals: readonly string[]): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      let text = node;
      for (const secret of secretLiterals) {
        if (secret.length >= 3 && text.includes(secret)) {
          text = text.split(secret).join("[REDACTED]");
        }
      }
      return redactor.redactText(text);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

export interface CompileOptions {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly appProfileId: string;
  readonly surfaceKind?: "web" | "legacy_web" | "desktop";
  readonly tenantId?: string;
  readonly version?: number;
}

/** "Member ID" -> "memberId". Falls back to a positional name if nothing usable. */
function camelCase(raw: string, fallbackIndex: number): string {
  const words = raw
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return `input${fallbackIndex}`;

  const head = words[0]!.toLowerCase();
  const tail = words.slice(1).map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
  const name = head + tail.join("");
  return /^[a-z]/.test(name) ? name : `input${fallbackIndex}`;
}

const SECRET_HINT = /pass(word|wd)?|secret|token|pin\b/i;
/**
 * Fields whose values are regulated even though they are not credentials.
 *
 * Marked so a deployment can turn on redaction for them. It is off by default
 * here so the demo's evidence stays inspectable — that switch is precisely the
 * knob a real institution would set the other way, and keeping it explicit is
 * better than pretending the classification does not exist.
 */
const PII_HINT = /member|account|ssn|social|tax|birth|dob|address|phone|operator|user|login|staff|teller/i;

function classify(label: string, isSecretField: boolean): "none" | "pii" | "secret" {
  if (isSecretField || SECRET_HINT.test(label)) return "secret";
  if (PII_HINT.test(label)) return "pii";
  return "none";
}

/** The label a step's target presents to a person, used for naming and classification. */
function labelOf(target: ObservedElement | undefined): string {
  if (target === undefined) return "";
  if (target.name !== "") return target.name;
  if (target.anchorText !== null) return target.anchorText;
  return target.hints.fieldName ?? "";
}

/**
 * Decides whether a typed value becomes an input parameter or stays a literal.
 *
 * Deterministic and explainable by design:
 *
 *   - Anything typed into a credential-shaped field is always a parameter.
 *     Baking a password into an artifact would be indefensible regardless of
 *     how the run was phrased.
 *   - A value that appears in the goal is a parameter, because the goal is
 *     where the caller expressed what varies per invocation. "look up member
 *     12345" says plainly that 12345 is the argument.
 *   - Everything else stays a literal. A dropdown option like "Savings" chosen
 *     to satisfy the flow is part of the recorded procedure, not a caller input.
 *
 * The limitation is worth stating: a value that varies per call but happened
 * not to be mentioned in the goal will be frozen as a literal. That is visible
 * in the artifact and fixable by a reviewer, which is the reason the artifact
 * is designed to be read rather than trusted blindly.
 */
function shouldParameterise(step: TraceStep, goal: string): boolean {
  if (step.action.kind !== "fill" && step.action.kind !== "select") return false;
  const label = labelOf(step.target);
  if (SECRET_HINT.test(label) || step.target?.hints.inputType === "password") return true;

  const value = "value" in step.action ? step.action.value : "";
  if (value.length < 2) return false;
  return goal.toLowerCase().includes(value.toLowerCase());
}

/**
 * Derives the condition that proves the goal was reached.
 *
 * Prefers something invariant across invocations. A final screen titled
 * "Member 12345" would pass for one input and fail for every other, so the
 * label beside the extracted value is used instead — it identifies the screen
 * without encoding the argument.
 *
 * An automatically derived checkpoint is a starting point, not a guarantee.
 * It is one of the things the artifact is explicitly reviewable for.
 */
function deriveSuccessCheckpoint(
  trace: readonly TraceStep[],
  finalTitle: string,
): { description: string; detector: Detector } {
  for (let i = trace.length - 1; i >= 0; i--) {
    const step = trace[i];
    if (step === undefined || step.target === undefined) continue;
    const anchor = step.target.anchorText;
    if (anchor !== null && anchor !== "" && !/^\d+$/.test(anchor)) {
      return {
        description: `The screen showing "${anchor}" was reached, which is where the requested value lives.`,
        detector: { kind: "text_present", text: anchor },
      };
    }
  }

  return {
    description: `The final screen titled "${finalTitle}" was reached.`,
    detector: { kind: "title_equals", value: finalTitle },
  };
}

export interface CompileReport {
  readonly capability: Capability;
  /** Decisions a reviewer should look at. Surfaced rather than buried in the artifact. */
  readonly notes: readonly string[];
}

export function compile(result: DiscoveryResult, options: CompileOptions): CompileReport {
  if (result.status !== "succeeded") {
    throw new Error(
      `Refusing to compile a ${result.status} run. A capability recorded from a flow that did not ` +
        `reach its goal would encode the failure as the procedure.`,
    );
  }

  const profile = appProfile(options.appProfileId);
  const notes: string[] = [];

  const inputs: CapabilityInput[] = [];
  const outputs: CapabilityOutput[] = [];
  const steps: Step[] = [];
  const usedNames = new Set<string>();
  const secretLiterals: string[] = [];

  // Every element observed in any step, so uniqueness can be assessed against
  // what was actually on screen rather than against the single target.
  const allObserved: ObservedElement[] = trace_targets(result.trace);

  for (const step of result.trace) {
    const target =
      step.target === undefined ? undefined : deriveTarget(step.target, allObserved);

    let value: ValueRef | undefined;

    if (step.action.kind === "fill" || step.action.kind === "select") {
      const literal = step.action.value;
      const label = labelOf(step.target);
      const isSecretField = step.target?.hints.inputType === "password";

      if (shouldParameterise(step, result.goal)) {
        let name = camelCase(label, inputs.length);
        while (usedNames.has(name)) name = `${name}2`;
        usedNames.add(name);

        const sensitivity = classify(label, isSecretField);
        inputs.push({
          name,
          type: "string",
          required: true,
          description: `Value for ${label !== "" ? `"${label}"` : "an unlabelled field"}.`,
          sensitivity,
          // Examples are stored only for values classified as non-sensitive.
          // An artifact is committed to a repository and read by reviewers, so
          // an "illustrative" real member number or operator id would be
          // precisely the leak parameterisation exists to prevent — and a
          // synthetic-looking value in a demo is no argument, because the same
          // code path runs against production data.
          ...(sensitivity === "none" ? { example: literal } : {}),
        });
        if (sensitivity === "secret") secretLiterals.push(literal);
        value = { param: name };
        notes.push(
          `Step ${step.index}: "${literal.length > 24 ? "(long value)" : sensitivity === "secret" ? "(secret)" : literal}" ` +
            `became input '${name}' (${sensitivity}).`,
        );
      } else {
        value = { literal };
        notes.push(
          `Step ${step.index}: kept "${literal}" as a literal — it is part of the recorded procedure, ` +
            `not a caller argument. Review if it should vary per invocation.`,
        );
      }
    }

    if (step.action.kind === "read" && step.outputName !== undefined) {
      const label = labelOf(step.target);
      outputs.push({
        name: step.outputName,
        type: "string",
        description: `Value read from ${label !== "" ? `"${label}"` : "the screen"}.`,
        sensitivity: classify(label, false),
        fromStep: steps.length,
      });
    }

    steps.push({
      index: steps.length,
      intent: step.intent,
      action: step.action.kind,
      ...(target === undefined ? {} : { target }),
      ...(value === undefined ? {} : { value }),
      ...(step.outputName === undefined ? {} : { outputName: step.outputName }),
      ...(step.action.kind === "navigate" ? { url: step.action.url } : {}),
      // Reviewed reversibility starts from what the policy engine decided
      // during discovery, then a human can correct it in the artifact.
      risk: step.policy.verdict === "confirm" ? "risky_irreversible" : "safe_reversible",
      waitMs: 0,
    });
  }

  // Checkpoints the agent recorded are attached to the step they followed.
  for (const checkpoint of result.checkpoints) {
    const step = steps[checkpoint.afterStep];
    if (step === undefined) continue;
    steps[checkpoint.afterStep] = {
      ...step,
      checkpoint: {
        description: checkpoint.description,
        detector: { kind: "text_present", text: firstQuotedOrWords(checkpoint.description) },
      },
    };
  }

  const finalTitle = result.trace.at(-1)?.titleBefore ?? "";
  const successCheckpoint = deriveSuccessCheckpoint(result.trace, finalTitle);

  if (outputs.length === 0) {
    notes.push(
      "No outputs were declared. A capability that returns nothing is usually a recording mistake — " +
        "check that the agent called read for the values the goal asked for.",
    );
  }

  const draft = scrubFreeText(
    {
    schemaVersion: 1,
    id: options.id,
    version: options.version ?? 1,
    name: options.name,
    description: options.description,
    approvalState: "draft",
    surface: {
      kind: options.surfaceKind ?? "legacy_web",
      entrypoint: result.entrypoint,
      appProfileId: profile.id,
    },
    lineage: {
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      overrides: [],
    },
    inputs,
    outputs,
    steps,
    successCheckpoint,
    // Merged from the profile: the application's vocabulary, not this flow's.
    knownOutcomes: profile.knownOutcomes,
    provenance: {
      discoveryRunId: options.id,
      goal: result.goal,
      model: "recorded",
      recordedAt: new Date().toISOString(),
      tracedSteps: result.trace.length,
      },
    },
    secretLiterals,
  );

  const capability = CapabilitySchema.parse(draft);
  return { capability, notes: scrubFreeText(notes, secretLiterals) };
}

/** Collects the observed elements from a trace, for uniqueness assessment. */
function trace_targets(trace: readonly TraceStep[]): ObservedElement[] {
  const out: ObservedElement[] = [];
  for (const step of trace) if (step.target !== undefined) out.push(step.target);
  return out;
}

/**
 * Extracts a detector string from a free-text checkpoint description.
 *
 * A description written for a human is not a detector, so this takes the most
 * specific quoted fragment if there is one and otherwise gives up on precision
 * deliberately — a reviewer tightening a checkpoint is a better outcome than a
 * compiler inventing an assertion nobody checked.
 */
function firstQuotedOrWords(description: string): string {
  const quoted = /"([^"]{3,60})"/.exec(description);
  if (quoted?.[1] !== undefined) return quoted[1];
  return description.split(/[.;]/)[0]!.slice(0, 60).trim();
}
