/**
 * Reviewed revisions of a capability.
 *
 * A recording captures one run of one flow, on data that happened to take the
 * happy path. What the flow means for data that does not — a member with no
 * savings account — is learned afterwards, in review or from production
 * failures, and has to reach the artifact without re-recording it.
 *
 * A revision is itself a small reviewed document: the exact capability and
 * version it was written against, who reviewed it, when, and why. Applying it
 * is deterministic, so a revised version can be regenerated and checked against
 * what is committed. The result is always a new version, returned to draft: an
 * approval covers the artifact that was reviewed, not its successor.
 */

import { z } from "zod";

import { type Capability, CapabilityOutcomeSchema, CapabilitySchema } from "../schema/capability.js";

export const ReviewSchema = z.strictObject({
  capabilityId: z.string().min(1),
  /** The version this review was written against. Applying it to any other version is refused. */
  baseVersion: z.number().int().positive(),
  reviewer: z.string().min(1),
  revisedAt: z.string().min(1),
  /** Why the change is needed. Written for the next reviewer; must not quote customer data. */
  summary: z.string().min(1),
  addOutcomes: z.array(CapabilityOutcomeSchema).min(1),
});
export type Review = z.infer<typeof ReviewSchema>;

export class RevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionError";
  }
}

export function parseReview(raw: unknown): Review {
  return ReviewSchema.parse(raw);
}

export function reviseCapability(base: Capability, review: Review): Capability {
  if (review.capabilityId !== base.id) {
    throw new RevisionError(`the review is for '${review.capabilityId}', not '${base.id}'`);
  }
  // A review describes a specific artifact. Applied to a later version, it
  // could reference steps that have since moved or been re-recorded.
  if (review.baseVersion !== base.version) {
    throw new RevisionError(
      `the review was written against v${review.baseVersion}, but this artifact is v${base.version}; ` +
        "review it again against the current version",
    );
  }
  const existing = new Set(base.knownOutcomes.map((outcome) => outcome.code));
  for (const outcome of review.addOutcomes) {
    if (existing.has(outcome.code)) {
      throw new RevisionError(`outcome ${outcome.code} already exists in v${base.version}`);
    }
  }

  const version = base.version + 1;
  const changes = review.addOutcomes.map((outcome) =>
    "absentTarget" in outcome
      ? `added outcome ${outcome.code}: the target of step ${outcome.absentTarget.step} is absent`
      : `added outcome ${outcome.code}: ${outcome.detector.kind}` +
        (outcome.atSteps === undefined ? "" : ` at step ${outcome.atSteps.join(", ")}`),
  );

  // Parsed again, so every cross-field rule — steps exist, codes are unique —
  // holds for the result and not only for the parts that were checked here.
  return CapabilitySchema.parse({
    ...base,
    version,
    approvalState: "draft",
    knownOutcomes: [...base.knownOutcomes, ...review.addOutcomes],
    provenance: {
      ...base.provenance,
      revisions: [
        ...base.provenance.revisions,
        { version, revisedAt: review.revisedAt, reviewer: review.reviewer, summary: review.summary, changes },
      ],
    },
  });
}
