/**
 * An application profile: what every capability recorded against one product
 * needs to know, recorded once.
 *
 * The insight this exists to capture is that a runtime condition is a property
 * of the APPLICATION, not of any particular flow. "No member found", the
 * maintenance interstitial, the session-timeout screen — these are the vendor
 * product's vocabulary. Every capability recorded against that product hits the
 * same ones, and so does every tenant running it.
 *
 * The profile sorts every unexpected screen into exactly one of three
 * vocabularies, because what replay should DO differs completely:
 *
 *   knownOutcomes      A legitimate answer the caller needs. Returned as a
 *                      result, never as an error.
 *   recoverables       Something replay can fix and continue past, with a
 *                      bounded number of attempts.
 *   fatalConditions    A state where waiting cannot help. Replay stops at once
 *                      with evidence rather than running out its timeout.
 *
 * Two consequences matter for the brief:
 *
 * - A discovery run sees the happy path by construction. It could not have
 *   learned what "record not found" looks like without deliberately provoking
 *   it, so these are declared here and merged into artifacts at compile time
 *   rather than invented per recording.
 *
 * - Across tenants, this is the layer that actually gets shared. Institutions
 *   running the same core product differ in hostnames, branding and sometimes
 *   field labels, but share this vocabulary — so a tenant's capability can
 *   inherit one profile and override only what genuinely differs.
 */

import { z } from "zod";

import { DetectorSchema, KnownOutcomeSchema, TargetSchema } from "./capability.js";

/**
 * Something replay can fix by itself and continue.
 *
 * Attempts are bounded because an unbounded remedy loop is how a transient
 * condition becomes an infinite one.
 */
export const RecoverableSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  detector: DetectorSchema,
  remedy: z.discriminatedUnion("kind", [
    /** Dismiss a known interstitial by clicking its continue control. Searched in every frame. */
    z.object({ kind: z.literal("click"), target: TargetSchema }),
    /** Wait, then re-observe. */
    z.object({ kind: z.literal("wait"), ms: z.number().int().positive() }),
    /**
     * Re-run the capability's authentication steps on the same session, then
     * resume after them. Deliberately not a generic "retry from the start":
     * re-authenticating is safe to repeat, replaying an irreversible step is
     * not — so replay refuses this remedy once such a step has run.
     */
    z.object({ kind: z.literal("reauthenticate") }),
  ]),
  maxAttempts: z.number().int().positive().default(2),
});
export type Recoverable = z.infer<typeof RecoverableSchema>;

/** A state that waiting will not change. */
export const FatalConditionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  detector: DetectorSchema,
});
export type FatalCondition = z.infer<typeof FatalConditionSchema>;

export const AppProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
  name: z.string().min(1),
  vendor: z.string().min(1),
  /** Vendor release this profile was authored against. Drift is tracked per tenant. */
  productVersion: z.string().min(1),
  knownOutcomes: z.array(KnownOutcomeSchema).default([]),
  recoverables: z.array(RecoverableSchema).default([]),
  fatalConditions: z.array(FatalConditionSchema).default([]),
});
export type AppProfile = z.infer<typeof AppProfileSchema>;

/**
 * Profile for the demo target.
 *
 * Authored by hand, as a real one would be: an integrator writes it once per
 * vendor product by provoking each condition deliberately, which is exactly
 * what a discovery run cannot do for itself.
 *
 * Slow renders are deliberately NOT a recoverable here. Replay already waits
 * for each target with a bounded poll, which absorbs transient slowness and is
 * recorded as a recovery when it happens. A detector-driven "page looks empty,
 * wait" rule cannot tell a slow load from the ordinary gap during any frame
 * navigation, so it would spend its attempt budget on normal page loads and
 * turn a healthy run into a failure.
 */
export const MERIDIAN_PROFILE: AppProfile = AppProfileSchema.parse({
  schemaVersion: 1,
  id: "meridian_core",
  name: "MERIDIAN CORE — Member Servicing",
  vendor: "Meridian",
  productVersion: "demo",

  knownOutcomes: [
    {
      code: "MEMBER_NOT_FOUND",
      description: "No member exists with the supplied ID. A legitimate answer, not a failure.",
      detector: { kind: "text_present", text: "No member found for ID" },
      terminal: true,
    },
    {
      code: "PERMISSION_DENIED",
      description:
        "The member record exists but this operator's role cannot view it. The caller needs to " +
        "distinguish this from not-found, because the remedy is an access request rather than a corrected ID.",
      detector: { kind: "text_present", text: "Not authorized to view member" },
      terminal: true,
    },
    {
      code: "MEMBER_ID_INVALID",
      description: "The application rejected the member ID's format. The caller supplied a malformed value.",
      detector: { kind: "text_present", text: "Member ID must be numeric" },
      terminal: true,
    },
    {
      code: "VALIDATION_REJECTED",
      description: "The application rejected the submitted values. The caller should correct inputs and retry.",
      detector: { kind: "text_present", text: "must be at least" },
      terminal: true,
    },
    {
      code: "REQUIRED_FIELD_MISSING",
      description: "The application reported that a required field was not supplied.",
      // Precise on purpose. An earlier version matched the bare phrase "is
      // required", which the maintenance notice also contains ("No action is
      // required."). Outcomes are checked before recoverables, so that notice
      // was reported to the caller as a missing-field answer instead of being
      // dismissed. An over-broad detector never errors; it silently swallows
      // recovery. tests/profile-detectors.test.ts now pins every detector to
      // exactly the screens it is meant to recognise.
      detector: {
        kind: "text_matches",
        pattern: "\\b(Operator ID|Password|Member ID|Account Type|Initial Deposit) is required\\b",
      },
      terminal: true,
    },
  ],

  recoverables: [
    {
      id: "maintenance_interstitial",
      description:
        "A scheduled-maintenance notice that can appear before any screen. Dismissing it returns " +
        "to the requested page, so replay clears it and continues rather than failing.",
      detector: { kind: "text_present", text: "Scheduled maintenance notice" },
      remedy: {
        kind: "click",
        target: {
          description: "the Continue button on the maintenance notice",
          framePath: [],
          actionable: true,
          strategies: [
            {
              strategy: { kind: "role_name", role: "button", name: "Continue" },
              confidence: 0.9,
              rationale: "The interstitial has exactly one control, labelled Continue.",
            },
          ],
        },
      },
      maxAttempts: 2,
    },
    {
      id: "session_expired",
      description:
        "The session timed out mid-flow. Re-running the capability's authentication steps on the " +
        "same browser recovers it; replaying the whole flow could repeat an irreversible step.",
      detector: { kind: "text_present", text: "session has timed out" },
      remedy: { kind: "reauthenticate" },
      maxAttempts: 1,
    },
  ],

  fatalConditions: [
    {
      id: "application_error",
      description:
        "The application returned its generic error page. Waiting will not change that, so replay " +
        "stops immediately with evidence instead of running out its timeout.",
      detector: { kind: "text_present", text: "Unexpected error processing your request" },
    },
  ],
});

const PROFILES: Readonly<Record<string, AppProfile>> = {
  [MERIDIAN_PROFILE.id]: MERIDIAN_PROFILE,
};

export function appProfile(id: string): AppProfile {
  const profile = PROFILES[id];
  if (profile === undefined) {
    throw new Error(
      `Unknown app profile '${id}'. A capability cannot be compiled or replayed without one, ` +
        `because its outcome and recovery vocabulary lives there.`,
    );
  }
  return profile;
}
