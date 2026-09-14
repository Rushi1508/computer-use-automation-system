/**
 * The capability artifact: a recorded flow turned into something an AI agent
 * can call and a human can review.
 *
 * Shaped around four claims, each of which the rest of the system depends on:
 *
 * 1. A capability is a CONTRACT, not a step list. Inputs and outputs are typed
 *    and named, so a caller knows what to supply and what comes back without
 *    reading the steps. The same Zod definitions validate a stored artifact and
 *    generate the JSON Schema an agent is given to invoke it — one source of
 *    truth for a shape a model and a runtime validator both have to agree on.
 *
 * 2. A target is a RANKED SET of independent ways to find a control, not one
 *    selector. Each strategy records why it is trustworthy, and replay records
 *    which one actually resolved. When the primary stops working and a fallback
 *    carries the step, that is a drift signal available for free rather than a
 *    silent degradation.
 *
 * 3. Values live in PARAMETERS, never in steps. A step references an input by
 *    name; the literal never enters the artifact. This is what makes "never
 *    persist PII or secrets" a structural property rather than a filter someone
 *    has to remember to run.
 *
 * 4. Business outcomes belong to the APPLICATION, not to the flow. "No such
 *    member" is the vendor product's vocabulary, shared by every capability
 *    recorded against it and by every tenant running it — so outcomes are
 *    merged in from an app profile rather than rediscovered per recording. A
 *    discovery run sees the happy path by construction and could not have
 *    learned them anyway. Outcomes that only mean something at one point in
 *    one flow ("this member has no savings account") are declared on the
 *    capability instead, in review, and scoped to the step they answer.
 */

import { z } from "zod";

import { ACTION_KINDS } from "../perception/types.js";

// --- Detectors ---------------------------------------------------------------

/**
 * An observable condition. Used for checkpoints and for recognising business
 * outcomes. Deliberately expressed against what a human sees — text on screen,
 * the address bar — rather than against DOM internals, so a detector survives
 * the markup churn that a selector would not.
 */
export const DetectorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text_present"),
    text: z.string().min(1),
    /** Restrict the search to one frame. Omitted means anywhere on screen. */
    framePath: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("text_absent"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("text_matches"),
    /**
     * A regular expression over the visible text, for messages that vary by
     * field or value. Prefer this to a short text_present phrase: a detector
     * that is too broad does not fail loudly, it silently misclassifies screens.
     */
    pattern: z
      .string()
      .min(1)
      .refine((pattern) => {
        try {
          new RegExp(pattern);
          return true;
        } catch {
          return false;
        }
      }, "must be a valid regular expression"),
    framePath: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("url_contains"), value: z.string().min(1) }),
  z.object({ kind: z.literal("title_equals"), value: z.string().min(1) }),
  z.object({
    kind: z.literal("grid_column"),
    /**
     * A data grid with this column header has rendered at least one row.
     * Structural rather than textual: the word "Balance" also turns up in
     * banners and prose, a cell under a "Balance" header does not. Use it as
     * proof that a region has loaded before concluding anything from what is
     * missing from it.
     */
    column: z.string().min(1),
    framePath: z.array(z.string()).optional(),
  }),
]);
export type Detector = z.infer<typeof DetectorSchema>;

// --- Locator strategies ------------------------------------------------------

/**
 * One way to find a control, with the reasoning that justifies its rank.
 *
 * Ordering is the whole point. Semantic strategies come first because they
 * describe the control the way an operator perceives it and survive cosmetic
 * change; generated framework ids come last because they churn between releases
 * of the vendor product and are the first thing to break after an upgrade.
 */
export const StrategySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role_name"),
    role: z.string(),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("anchored_row"),
    role: z.string(),
    /** Text of the labelling cell that identifies this control to a person. */
    anchorText: z.string().min(1),
  }),
  z.object({
    kind: z.literal("grid_cell"),
    /** Header text of the column the value sits under. */
    column: z.string().min(1),
    /** Text of another cell in the same row that identifies the row. */
    rowContains: z.string().min(1),
  }),
  z.object({ kind: z.literal("field_name"), fieldName: z.string().min(1) }),
  z.object({ kind: z.literal("dom_id"), domId: z.string().min(1) }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const RankedStrategySchema = z.object({
  strategy: StrategySchema,
  /** 0-1. Replay prefers higher; a win by a low-confidence strategy is a drift signal. */
  confidence: z.number().min(0).max(1),
  /** Why this is or is not durable. Written for a human reviewing the artifact. */
  rationale: z.string().min(1),
});
export type RankedStrategy = z.infer<typeof RankedStrategySchema>;

export const TargetSchema = z.object({
  /** Human-readable identification, e.g. 'the Member ID textbox'. */
  description: z.string().min(1),
  framePath: z.array(z.string()),
  /** Whether the control can be operated or only read. */
  actionable: z.boolean(),
  /** At least one. Ordered most to least trustworthy. */
  strategies: z.array(RankedStrategySchema).min(1),
});
export type Target = z.infer<typeof TargetSchema>;

// --- Inputs and outputs ------------------------------------------------------

/**
 * How sensitive a value is. Drives redaction and storage, and is the mechanism
 * by which regulated data is kept out of artifacts and evidence.
 */
export const SensitivitySchema = z.enum(["none", "pii", "secret"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const InputSchema = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/, "camelCase"),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  description: z.string().min(1),
  sensitivity: SensitivitySchema,
  /**
   * A safe illustrative value. Never the recorded literal for a secret — the
   * point of parameterising credentials is that they leave no trace.
   */
  example: z.string().optional(),
});
export type CapabilityInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/, "camelCase"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().min(1),
  sensitivity: SensitivitySchema,
  /** Index of the step that produces it, so a reviewer can trace provenance. */
  fromStep: z.number().int().nonnegative(),
});
export type CapabilityOutput = z.infer<typeof OutputSchema>;

// --- Steps -------------------------------------------------------------------

/**
 * What a step does. Values are references, never literals: `{ param: "memberId" }`
 * or `{ literal: "Savings" }` where the literal is a non-sensitive UI constant
 * such as a dropdown option.
 */
export const ValueRefSchema = z.union([
  z.object({ param: z.string().min(1) }),
  z.object({ literal: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRefSchema>;

export const StepSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Why this step exists, recorded by the agent at discovery time. */
  intent: z.string().min(1),
  action: z.enum(ACTION_KINDS),
  target: TargetSchema.optional(),
  value: ValueRefSchema.optional(),
  /** Where a `read` step's result goes. */
  outputName: z.string().optional(),
  url: z.string().optional(),
  /**
   * Reviewed reversibility. It can only add caution: replay treats a step as
   * irreversible if this says so or if the policy reads the live control as
   * irreversible, so a step edited down to safe_reversible still stops for a
   * person.
   */
  risk: z.enum(["safe_reversible", "risky_irreversible"]),
  waitMs: z.number().int().nonnegative().default(0),
  /** Asserted after the step. Proves arrival rather than assuming the click worked. */
  checkpoint: z
    .object({ description: z.string().min(1), detector: DetectorSchema })
    .optional(),
});
export type Step = z.infer<typeof StepSchema>;

// --- Business outcomes -------------------------------------------------------

/**
 * A legitimate answer the caller needs, distinct from a failure.
 *
 * Conflating "no such member" with a crash is the mistake the brief calls out,
 * and it is prevented here by giving outcomes their own declared vocabulary
 * with detectors, separate from the failure path entirely.
 */
const OutcomeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "SCREAMING_SNAKE_CASE");

export const KnownOutcomeSchema = z.strictObject({
  code: OutcomeCodeSchema,
  description: z.string().min(1),
  detector: DetectorSchema,
  /**
   * Steps at which the detector counts. Omitted means anywhere in the flow.
   *
   * Scope an outcome whose text is only an answer at one point: "No open
   * accounts." ends a balance lookup, but must not end a flow that is about to
   * open the member's first account.
   */
  atSteps: z.array(z.number().int().nonnegative()).min(1).optional(),
  /** Whether reaching this outcome means the flow stops. */
  terminal: z.boolean().default(true),
});
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

/**
 * A legitimate answer recognised by what is not on screen: the member's
 * accounts are showing, and none of them is a savings account.
 *
 * Absence is the most dangerous evidence there is, because "not there yet",
 * "not there because the page broke" and "not there because there is no such
 * thing" look identical at a glance. Treating any of the first two as the third
 * returns a wrong answer to the caller with a success-shaped status. So an
 * absence outcome requires three things, and a missing target without all
 * three stays a failure:
 *
 *   scope      it applies to one step's target, never to the screen at large
 *   proof      a positive detector shows the region the target lives in has
 *              rendered (text_absent is refused: it proves nothing)
 *   stability  replay sees the absence on consecutive observations
 *
 * A locator strategy that matches several elements is not absence. That is
 * ambiguity, and it is reported as a failure of its own.
 */
export const AbsenceOutcomeSchema = z.strictObject({
  code: OutcomeCodeSchema,
  description: z.string().min(1),
  absentTarget: z.strictObject({
    /** The step whose target's absence is the answer. */
    step: z.number().int().nonnegative(),
    screenReady: DetectorSchema.refine(
      (detector) => detector.kind !== "text_absent",
      "screenReady must be positive evidence that the screen has rendered; text_absent proves nothing",
    ),
  }),
  terminal: z.literal(true).default(true),
});
export type AbsenceOutcome = z.infer<typeof AbsenceOutcomeSchema>;

export const CapabilityOutcomeSchema = z.union([KnownOutcomeSchema, AbsenceOutcomeSchema]);
export type CapabilityOutcome = z.infer<typeof CapabilityOutcomeSchema>;

// --- The capability ----------------------------------------------------------

export const CapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
  /** Bumped on every re-record or edit. Replay reports the version it ran. */
  version: z.number().int().positive(),
  name: z.string().min(1),
  /** Agent-facing. What this capability does, in one or two sentences. */
  description: z.string().min(1),
  /**
   * Draft capabilities re-prompt on risky steps; approved ones do not. Gating
   * unattended execution on an explicit review state keeps a freshly-recorded
   * flow from moving money on its first invocation.
   *
   * Not taken on trust from the file. The loader (schema/load.ts) sets it to
   * approved only when a detached approval record's digest matches this
   * artifact (schema/approval.ts), so an artifact cannot approve itself and an
   * edited one loses its approval. Compiled and revised artifacts are always
   * written as draft.
   */
  approvalState: z.enum(["draft", "approved"]).default("draft"),

  surface: z.object({
    kind: z.enum(["web", "legacy_web", "desktop"]),
    entrypoint: z.string().min(1),
    /** Which application profile supplies this capability's outcome vocabulary. */
    appProfileId: z.string().min(1),
  }),

  /**
   * Multi-tenant reuse. A capability recorded against one tenant's instance of
   * a vendor product names that recording as its base; a sibling tenant reuses
   * it and records only what differs, rather than re-recording the flow.
   */
  lineage: z.object({
    baseCapabilityId: z.string().optional(),
    tenantId: z.string().optional(),
    /** Per-tenant step overrides, applied over the base at load time. */
    overrides: z
      .array(z.object({ stepIndex: z.number().int().nonnegative(), target: TargetSchema }))
      .default([]),
  }),

  inputs: z.array(InputSchema),
  outputs: z.array(OutputSchema),
  steps: z.array(StepSchema).min(1),

  /**
   * The prefix of steps that establishes a session, when the flow signs on.
   * Lets replay recover from session expiry by re-running only these steps on
   * the same browser, instead of replaying the whole flow — which would repeat
   * any irreversible step already taken.
   */
  authentication: z.object({ throughStep: z.number().int().nonnegative() }).optional(),

  /** The condition that means the goal was actually reached. */
  successCheckpoint: z.object({
    description: z.string().min(1),
    detector: DetectorSchema,
  }),

  knownOutcomes: z.array(CapabilityOutcomeSchema).default([]),

  provenance: z.object({
    discoveryRunId: z.string().min(1),
    goal: z.string().min(1),
    model: z.string().min(1),
    recordedAt: z.string().min(1),
    /** Step count of the source trace, so a reviewer can spot compiler drops. */
    tracedSteps: z.number().int().nonnegative(),
    /**
     * Reviewed edits made after recording, oldest first. Each one produced a
     * new version and returned the capability to draft.
     */
    revisions: z
      .array(
        z.strictObject({
          version: z.number().int().positive(),
          revisedAt: z.string().min(1),
          reviewer: z.string().min(1),
          summary: z.string().min(1),
          changes: z.array(z.string().min(1)).min(1),
        }),
      )
      .default([]),
  }),
}).superRefine((capability, ctx) => {
  // Rules that span fields. An outcome pointing at a step that does not exist
  // would never fire, and a silently dead outcome is how a legitimate answer
  // turns back into a failure.
  const steps = new Map(capability.steps.map((step) => [step.index, step]));
  const codes = new Set<string>();

  capability.knownOutcomes.forEach((outcome, i) => {
    if (codes.has(outcome.code)) {
      ctx.addIssue({ code: "custom", path: ["knownOutcomes", i, "code"], message: `duplicate outcome code ${outcome.code}` });
    }
    codes.add(outcome.code);

    if ("absentTarget" in outcome) {
      const n = outcome.absentTarget.step;
      if (steps.get(n)?.target === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["knownOutcomes", i, "absentTarget", "step"],
          message: `step ${n} does not exist or has no target, so its absence cannot be judged`,
        });
      }
      return;
    }
    for (const n of outcome.atSteps ?? []) {
      if (!steps.has(n)) {
        ctx.addIssue({ code: "custom", path: ["knownOutcomes", i, "atSteps"], message: `step ${n} does not exist` });
      }
    }
  });
});

export type Capability = z.infer<typeof CapabilitySchema>;

/** Parses and validates a stored artifact, throwing with a readable path on failure. */
export function parseCapability(raw: unknown): Capability {
  return CapabilitySchema.parse(raw);
}

/**
 * The JSON Schema an agent receives to invoke this capability.
 *
 * Generated from the same definitions that validate the artifact, so the
 * contract a caller is shown cannot drift from the contract that is enforced.
 */
export function invocationSchema(capability: Capability): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const input of capability.inputs) {
    properties[input.name] = {
      type: input.type,
      description:
        input.sensitivity === "secret"
          ? `${input.description} (secret — supplied from the credential store, never logged)`
          : input.description,
    };
    if (input.required) required.push(input.name);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
