/**
 * Approval, bound to what was approved.
 *
 * Approval is what lets a capability run its irreversible steps without a
 * person confirming each one. If it were a field the artifact could set on
 * itself, anyone able to edit the file could grant it — and editing the file is
 * exactly what tampering is. So approval is not taken from the artifact. It is a
 * detached record, written by a reviewer, naming the capability, the version and
 * a digest of the artifact's content, and it is honoured only while that digest
 * still matches:
 *
 *   - an artifact that merely says "approved" is treated as a draft;
 *   - an approved artifact edited afterwards — a step's risk downgraded, a
 *     target swapped — no longer matches its record and is treated as a draft;
 *   - approving never rewrites the artifact, so versions stay immutable.
 *
 * This is integrity, not authentication. Whoever can write approval records can
 * approve, so the record directory is what a deployment puts under
 * reviewer-only write access. It is deliberately not a signature scheme: the
 * property the system needs is that a changed artifact loses its approval, and a
 * digest gives that without key management.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { Capability } from "./capability.js";

/** Subdirectory, next to the artifacts, holding one approval record per approved version. */
export const APPROVALS_DIR = "approvals";

export const ApprovalRecordSchema = z.strictObject({
  capabilityId: z.string().min(1),
  version: z.number().int().positive(),
  /** sha256 over the artifact's canonical content, excluding approvalState. */
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256:<64 hex digits>"),
  approvedBy: z.string().min(1),
  approvedAt: z.string().min(1),
  note: z.string().default(""),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/** JSON with object keys in a fixed order, so a digest does not depend on formatting. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The digest an approval is bound to. Computed over the parsed artifact, so
 * whitespace and key order do not matter but every step, target, risk class and
 * outcome does. approvalState is left out: it is the thing being decided, not
 * part of what was reviewed.
 */
export function capabilityDigest(capability: Capability): string {
  const content: Record<string, unknown> = { ...capability };
  delete content["approvalState"];
  return `sha256:${createHash("sha256").update(canonical(content)).digest("hex")}`;
}

export function approvalRecordPath(artifactFile: string, id: string, version: number): string {
  return join(dirname(artifactFile), APPROVALS_DIR, `${id}.v${version}.json`);
}

export type ApprovalCheck =
  | { readonly approved: true; readonly record: ApprovalRecord }
  | { readonly approved: false; readonly warning: string | null };

/** Whether a matching, current approval record exists for an artifact read from `artifactFile`. */
export function checkApproval(capability: Capability, artifactFile: string): ApprovalCheck {
  const path = approvalRecordPath(artifactFile, capability.id, capability.version);
  const recordName = `${APPROVALS_DIR}/${capability.id}.v${capability.version}.json`;

  if (!existsSync(path)) {
    return {
      approved: false,
      warning:
        capability.approvalState === "approved"
          ? "declares itself approved, but there is no approval record for it; treated as draft"
          : null,
    };
  }

  let record: ApprovalRecord;
  try {
    record = ApprovalRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { approved: false, warning: `has a malformed approval record (${recordName}); treated as draft` };
  }

  if (record.capabilityId !== capability.id || record.version !== capability.version) {
    return {
      approved: false,
      warning: `has an approval record (${recordName}) for ${record.capabilityId} v${record.version} instead; treated as draft`,
    };
  }
  if (record.digest !== capabilityDigest(capability)) {
    return {
      approved: false,
      warning: "has an approval record, but its content has changed since it was approved (digest mismatch); treated as draft",
    };
  }
  return { approved: true, record };
}

export function approvalRecordFor(
  capability: Capability,
  approvedBy: string,
  note: string,
  now: Date = new Date(),
): ApprovalRecord {
  return ApprovalRecordSchema.parse({
    capabilityId: capability.id,
    version: capability.version,
    digest: capabilityDigest(capability),
    approvedBy,
    approvedAt: now.toISOString(),
    note,
  });
}
