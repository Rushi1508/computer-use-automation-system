/**
 * Loading an artifact from disk: the boundary between a file anyone may have
 * edited and the typed capability the rest of the system acts on.
 *
 * Every command that reads an artifact goes through here, for three reasons:
 *
 *   errors      A missing, empty, malformed or schema-invalid file is reported
 *               as a readable sentence naming the field at fault — never as a
 *               stack trace, a raw ZodError dump, or a path the caller did not
 *               type.
 *
 *   validation  Unchanged. The same CapabilitySchema, with every cross-field
 *               rule, decides what a valid artifact is.
 *
 *   approval    Whatever the file says, approvalState comes from a detached
 *               approval record whose digest still matches (see approval.ts).
 *               A self-declared or out-of-date approval is downgraded to draft
 *               and reported, so it cannot let an irreversible step run
 *               unattended.
 */

import { readFileSync, statSync } from "node:fs";

import type { z } from "zod";

import { checkApproval } from "./approval.js";
import { type Capability, CapabilitySchema } from "./capability.js";

export type JsonRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

/** Reads and parses a JSON file, describing any failure without internals. */
export function readJsonFile(file: string): JsonRead {
  let text: string;
  try {
    if (statSync(file).isDirectory()) return { ok: false, problem: "is a directory, not a file" };
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      problem: code === "ENOENT" ? "does not exist" : code === "EACCES" ? "cannot be read (permission denied)" : "cannot be read",
    };
  }

  if (text.trim() === "") return { ok: false, problem: "is empty" };
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, "")) };
  } catch (error) {
    // JSON.parse messages give a position and nothing else, which is exactly
    // the part worth keeping.
    return { ok: false, problem: `is not valid JSON (${error instanceof Error ? error.message : "parse error"})` };
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`))
    .join("");
}

/** One line per issue, each naming the field at fault: `steps[3].action: Invalid option: …`. */
export function describeSchemaError(error: z.ZodError, limit = 6): string[] {
  const lines = error.issues
    .slice(0, limit)
    .map((issue) => `${formatPath(issue.path) || "(top level)"}: ${issue.message}`);
  if (error.issues.length > limit) lines.push(`…and ${error.issues.length - limit} more`);
  return lines;
}

export type CapabilityLoad =
  | { readonly ok: true; readonly capability: Capability; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly problem: string };

export function readCapabilityFile(file: string): CapabilityLoad {
  const json = readJsonFile(file);
  if (!json.ok) return json;

  const parsed = CapabilitySchema.safeParse(json.value);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `is not a valid capability artifact:\n${describeSchemaError(parsed.error)
        .map((line) => `  - ${line}`)
        .join("\n")}`,
    };
  }

  const approval = checkApproval(parsed.data, file);
  const capability: Capability = { ...parsed.data, approvalState: approval.approved ? "approved" : "draft" };
  const warnings = !approval.approved && approval.warning !== null ? [approval.warning] : [];
  return { ok: true, capability, warnings };
}
