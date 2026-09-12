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
 * Two consequences follow, and both matter for the brief:
 *
 * - A discovery run sees the happy path by construction. It could not have
 *   learned what "record not found" looks like without deliberately provoking
 *   it, so outcomes are declared here and merged into artifacts at compile
 *   time rather than being invented per recording.
 *
 * - Across tenants, this is the layer that actually gets shared. Two
 *   institutions running the same core banking product have different
 *   hostnames, branding and sometimes field labels, but identical error
 *   vocabulary — so a per-tenant capability can inherit one profile and
 *   override only what genuinely differs.
 */

import { z } from "zod";

import { DetectorSchema, KnownOutcomeSchema, TargetSchema } from "./capability.js";

/**
 * Something replay can fix by itself and continue.
 *
 * Distinct from a business outcome, which is an answer the caller wants, and
 * from a hard failure, which stops the run. Attempts are bounded because an
 * unbounded remedy loop is how a transient condition becomes an infinite one.
 */
export const RecoverableSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  detector: DetectorSchema,
  remedy: z.discriminatedUnion("kind", [
    /** Dismiss a known interstitial by clicking its continue control. */
    z.object({ kind: z.literal("click"), target: TargetSchema }),
    /** Wait and re-observe. For transient slowness. */
    z.object({ kind: z.literal("wait"), ms: z.number().int().positive() }),
    /**
     * Re-run the capability's authentication steps on the same session.
     * Deliberately not a generic "retry from the start": re-authenticating is
     * safe to repeat, whereas replaying an irreversible step is not.
     */
    z.object({ kind: z.literal("reauthenticate") }),
  ]),
  maxAttempts: z.number().int().positive().default(2),
});
export type Recoverable = z.infer<typeof RecoverableSchema>;

export const AppProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
  name: z.string().min(1),
  vendor: z.string().min(1),
  /** Vendor release this profile was authored against. Drift is tracked per tenant. */
  productVersion: z.string().min(1),
  knownOutcomes: z.array(KnownOutcomeSchema).default([]),
  recoverables: z.array(RecoverableSchema).default([]),
});
export type AppProfile = z.infer<typeof AppProfileSchema>;

/**
 * Profile for the demo target.
 *
 * Authored by hand, as a real one would be: an integrator writes it once per
 * vendor product by provoking each condition deliberately, which is exactly
 * what a discovery run cannot do for itself.
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
      code: "VALIDATION_REJECTED",
      description: "The application rejected the submitted values. The caller should correct inputs and retry.",
      detector: { kind: "text_present", text: "must be at least" },
      terminal: true,
    },
    {
      code: "ACCOUNT_TYPE_REQUIRED",
      description: "A required field was not supplied.",
      detector: { kind: "text_present", text: "is required" },
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
      id: "transient_slow_load",
      description: "The screen had not finished rendering. Wait once and re-observe before failing.",
      detector: { kind: "text_absent", text: "MERIDIAN CORE" },
      remedy: { kind: "wait", ms: 2000 },
      maxAttempts: 2,
    },
    {
      id: "session_expired",
      description:
        "The session timed out mid-flow. Re-running the capability's authentication steps on the " +
        "same session recovers it; replaying the whole flow could repeat an irreversible step.",
      detector: { kind: "text_present", text: "session has timed out" },
      remedy: { kind: "reauthenticate" },
      maxAttempts: 1,
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
