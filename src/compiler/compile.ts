/**
 * Compiling a discovery trace into a capability artifact.
 *
 * This is a compilation, not a transcript dump. The trace is a record of what
 * one exploration did with one set of literal values; the artifact is a
 * reusable contract. Four transformations do the real work:
 *
 *   parameterisation   Literal values the run typed become named, typed inputs.
 *                      The literal never enters a step.
 *
 *   templating         Free text — intents, the goal, descriptions — has this
 *                      run's values replaced by the names that stand for them.
 *                      "Search for member 12345" becomes "Search for member
 *                      {memberId}", so the artifact describes the procedure
 *                      rather than one execution of it.
 *
 *   target derivation  Each per-observation node id becomes a ranked set of
 *                      durable strategies, with confidence computed from how
 *                      many elements each matched on the recorded screen.
 *
 *   outcome merge      The application's known business outcomes are merged in
 *                      from its profile, because a happy-path run could not
 *                      have learned them.
 *
 * Everything here is deterministic, including the recorded timestamp, so
 * recompiling the same trace always yields a byte-identical artifact and a
 * reviewer can reason about why each step looks the way it does.
 */

import type { DiscoveryResult, TraceStep } from "../agent/loop.js";
import type { ObservedElement } from "../perception/types.js";
import { redactor } from "../policy/redactor.js";
import { appProfile } from "../schema/app-profile.js";
import {
  type Capability,
  type CapabilityInput,
  type CapabilityOutput,
  CapabilitySchema,
  type Detector,
  type Step,
  type ValueRef,
} from "../schema/capability.js";
import { deriveTarget } from "./strategies.js";

export interface CompileOptions {
  readonly id: string;
  readonly name: string;
  /** Agent-facing description. Defaults to the templated goal. */
  readonly description?: string;
  readonly appProfileId: string;
  readonly surfaceKind?: "web" | "legacy_web" | "desktop";
  readonly tenantId?: string;
  readonly version?: number;
  readonly discoveryRunId?: string;
  readonly model?: string;
}

export interface CompileReport {
  readonly capability: Capability;
  /** Decisions a reviewer should look at. Surfaced rather than buried in the artifact. */
  readonly notes: readonly string[];
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
 * Classified so storage and evidence can treat them differently. The demo keeps
 * PII-classified values readable in evidence so checkpoints stay inspectable —
 * that is precisely the switch a real institution would set the other way, and
 * keeping the classification explicit is better than pretending it does not exist.
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
 *   - Anything typed into a credential-shaped field is always a parameter.
 *   - A value that appears in the goal is a parameter, because the goal is where
 *     the caller said what varies per invocation.
 *   - Everything else stays a literal: a dropdown option chosen to satisfy the
 *     flow is part of the procedure, not a caller argument.
 *
 * The limitation, stated rather than hidden: a value that varies per call but
 * went unmentioned in the goal is frozen as a literal. It is visible in the
 * artifact and in the compiler notes, which is why the artifact is built to be
 * read before it is approved.
 */
function shouldParameterise(step: TraceStep, goal: string): boolean {
  if (step.action.kind !== "fill" && step.action.kind !== "select") return false;
  const label = labelOf(step.target);
  if (SECRET_HINT.test(label) || step.target?.hints.inputType === "password") return true;

  const value = step.action.value;
  if (value.length < 2) return false;
  return goal.toLowerCase().includes(value.toLowerCase());
}

interface Substitution {
  readonly literal: string;
  readonly replacement: string;
}

/** Replaces this run's values in free text with the names that stand for them. */
function templatise(text: string, substitutions: readonly Substitution[]): string {
  let out = text;
  for (const { literal, replacement } of substitutions) {
    if (literal.length >= 2 && out.includes(literal)) out = out.split(literal).join(replacement);
  }
  return redactor.redactText(out);
}

/**
 * Removes every secret literal from every string in a structure — steps,
 * strategies, detectors, notes, all of it. Templating covers the free-text
 * fields; this is the backstop that makes "a credential never reaches an
 * artifact" hold even for a field nobody thought to template.
 */
function scrubSecrets<T>(value: T, secretLiterals: readonly string[]): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      let text = node;
      for (const secret of secretLiterals) {
        if (secret.length >= 3 && text.includes(secret)) text = text.split(secret).join("[REDACTED]");
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

interface DerivedCheckpoint {
  readonly description: string;
  readonly detector: Detector;
  /** True when the detector is a guess a reviewer should tighten before approving. */
  readonly weak: boolean;
}

/**
 * Derives the condition that proves the goal was reached.
 *
 * Prefers structural text that is the same for every invocation: the column
 * header of the grid a value was read from, then a label verified on screen at
 * record time. A title or anchor is a last resort and flagged as weak — a
 * detector on "Member 12345" would pass for one input and fail for all others.
 */
function deriveSuccessCheckpoint(result: DiscoveryResult): DerivedCheckpoint {
  for (let i = result.trace.length - 1; i >= 0; i--) {
    const step = result.trace[i];
    const grid = step?.target?.grid;
    if (step?.action.kind === "read" && grid !== undefined) {
      return {
        description: `The screen shows a grid with a "${grid.columnHeader}" column, where the returned value is read from.`,
        detector: { kind: "text_present", text: grid.columnHeader },
        weak: false,
      };
    }
  }

  for (let i = result.checkpoints.length - 1; i >= 0; i--) {
    const text = result.checkpoints[i]?.verifiedText ?? null;
    if (text !== null) {
      return {
        description: `The screen shows "${text}", as verified when the flow was recorded.`,
        detector: { kind: "text_present", text },
        weak: false,
      };
    }
  }

  const title = result.trace.at(-1)?.titleBefore ?? "";
  if (title !== "" && !/\d{3,}/.test(title)) {
    return {
      description: `The final screen is titled "${title}".`,
      detector: { kind: "title_equals", value: title },
      weak: true,
    };
  }

  for (let i = result.trace.length - 1; i >= 0; i--) {
    const anchor = result.trace[i]?.target?.anchorText ?? null;
    if (anchor !== null && anchor !== "" && !/\d{3,}/.test(anchor)) {
      return {
        description: `The screen showing "${anchor}" was reached.`,
        detector: { kind: "text_present", text: anchor },
        weak: true,
      };
    }
  }

  return {
    description: "The flow completed without the application's error page.",
    detector: { kind: "text_absent", text: "Unexpected error" },
    weak: true,
  };
}

/**
 * The steps that establish a session: everything up to and including the first
 * click after the last credential is typed.
 */
function deriveAuthentication(
  steps: readonly Step[],
  inputs: readonly CapabilityInput[],
): { throughStep: number } | undefined {
  const secretNames = new Set(inputs.filter((i) => i.sensitivity === "secret").map((i) => i.name));
  let lastSecret = -1;
  steps.forEach((step, i) => {
    if (step.value !== undefined && "param" in step.value && secretNames.has(step.value.param)) lastSecret = i;
  });
  if (lastSecret < 0) return undefined;
  const submit = steps.findIndex((step, i) => i > lastSecret && step.action === "click");
  return submit < 0 ? undefined : { throughStep: submit };
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
  const substitutions: Substitution[] = [];
  let uniquenessMissing = false;

  for (const step of result.trace) {
    if (step.target !== undefined && step.locatorEvidence === undefined) uniquenessMissing = true;
    const target =
      step.target === undefined ? undefined : deriveTarget(step.target, step.locatorEvidence ?? []);

    if (step.actor === "operator") {
      notes.push(
        `Step ${step.index} was performed by a human operator during a handoff. It is recorded as an ordinary ` +
          `step so the capability is complete; review whether automation should perform it unattended.`,
      );
    }

    const best = target?.strategies[0];
    if (target !== undefined && best !== undefined && best.confidence < 0.6) {
      notes.push(
        `Step ${step.index}: nothing identifies ${target.description} confidently — the best strategy is ` +
          `${best.strategy.kind} at ${best.confidence}. Replay may refuse to resolve it; review before approving.`,
      );
    }

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
          // Examples are stored only for non-sensitive inputs. An artifact is
          // committed and reviewed, so an "illustrative" real member number is
          // precisely the leak parameterisation exists to prevent.
          ...(sensitivity === "none" ? { example: literal } : {}),
        });

        if (sensitivity === "secret") {
          secretLiterals.push(literal);
          substitutions.push({ literal, replacement: "[REDACTED]" });
        } else {
          substitutions.push({ literal, replacement: `{${name}}` });
        }
        value = { param: name };
        // The note deliberately omits the value: notes are printed to a terminal.
        notes.push(`Step ${step.index}: typed value became input '${name}' (${sensitivity}).`);
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
        description: `Value read from ${target?.description ?? (label !== "" ? `"${label}"` : "the screen")}.`,
        sensitivity: classify(label, false),
        fromStep: steps.length,
      });
      if (step.extracted !== undefined && step.extracted.length >= 3) {
        substitutions.push({ literal: step.extracted, replacement: `{${step.outputName}}` });
      }
      const grid = step.target?.grid;
      if (grid !== undefined) {
        notes.push(
          `Step ${step.index}: output '${step.outputName}' is read from the "${grid.columnHeader}" column of the ` +
            `row containing "${step.target?.anchorText ?? ""}". An invocation whose data has no such row stops ` +
            `with target_not_found. If that is a legitimate answer for callers, declare an absentTarget outcome ` +
            `for this step, with a positive screenReady detector, and apply it with 'cua revise' before approving.`,
        );
      }
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
      // during discovery; a human corrects it in the artifact if needed.
      risk: step.policy.verdict === "confirm" ? "risky_irreversible" : "safe_reversible",
      waitMs: 0,
    });
  }

  if (uniquenessMissing) {
    notes.push(
      "This trace was recorded without locator evidence, so no strategy's uniqueness is known and every " +
        "confidence is reduced. Re-record before approving.",
    );
  }

  // Longest first, so "op-demo" is replaced before a shorter literal inside it.
  substitutions.sort((a, b) => b.literal.length - a.literal.length);
  const tpl = (text: string): string => templatise(text, substitutions);

  for (const checkpoint of result.checkpoints) {
    const step = steps[checkpoint.afterStep];
    if (step === undefined) continue;
    const text = checkpoint.verifiedText ?? null;
    if (text === null) {
      notes.push(
        `Checkpoint after step ${checkpoint.afterStep} was not attached: none of its text could be verified ` +
          `as a stable on-screen label, and asserting free prose would either fail on replay or encode this ` +
          `run's data.`,
      );
      continue;
    }
    steps[checkpoint.afterStep] = {
      ...step,
      checkpoint: { description: `The screen shows "${text}".`, detector: { kind: "text_present", text } },
    };
  }

  const success = deriveSuccessCheckpoint(result);
  if (success.weak) {
    notes.push(
      `The success checkpoint is a fallback (${success.detector.kind}) and may not distinguish the goal ` +
        `screen from others. Tighten it before approving.`,
    );
  }

  const authentication = deriveAuthentication(steps, inputs);

  if (outputs.length === 0) {
    notes.push(
      "No outputs were declared. A capability that returns nothing is usually a recording mistake — " +
        "check that the agent called read for the values the goal asked for.",
    );
  }

  const draft = {
    schemaVersion: 1,
    id: options.id,
    version: options.version ?? 1,
    name: options.name,
    description: tpl(options.description ?? result.goal),
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
    inputs: inputs.map((input) => ({ ...input, description: tpl(input.description) })),
    outputs: outputs.map((output) => ({ ...output, description: tpl(output.description) })),
    steps: steps.map((step) => ({ ...step, intent: tpl(step.intent) })),
    ...(authentication === undefined ? {} : { authentication }),
    successCheckpoint: { description: tpl(success.description), detector: success.detector },
    // Merged from the profile: the application's vocabulary, not this flow's.
    knownOutcomes: profile.knownOutcomes,
    provenance: {
      discoveryRunId: options.discoveryRunId ?? "unrecorded",
      goal: tpl(result.goal),
      model: options.model ?? "unrecorded",
      // Taken from the trace, not the clock, so recompiling is reproducible.
      recordedAt: result.trace.at(-1)?.at ?? "unrecorded",
      tracedSteps: result.trace.length,
    },
  };

  const capability = CapabilitySchema.parse(scrubSecrets(draft, secretLiterals));
  return { capability, notes: scrubSecrets(notes, secretLiterals) };
}
