/**
 * Publication redaction for the committed evidence.
 *
 * The demo application's data is synthetic, but it is shaped like a bank's:
 * member names, branches and account numbers. Committed evidence should not
 * read like a leaked customer record, so the scripts that write `evidence/`
 * pass their output through this step. In text files, those identifiers are
 * replaced with explicit markers; screenshots are taken with them blacked out.
 *
 * Deliberately kept: balances, because they are the capability's declared
 * output and identify nobody on their own, and member numbers, because they
 * are the documented inputs each scenario runs with.
 *
 * This is a publication step keyed on the demo's known dataset. It is not the
 * runtime's redaction: raw run output under `.runs/` is unchanged.
 * Classification-driven redaction of on-screen data is listed under Cuts in
 * REPORT.md.
 *
 *   tsx scripts/evidence-redaction.ts <dir>   applies it to a bundle promoted by hand
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { customerIdentifiers } from "../apps/legacy-demo/data.js";
import type { ScreenshotMask } from "../src/perception/web-playwright.js";

/** The demo's account number format. Also matches accounts opened during a run. */
const ACCOUNT_NUMBER = /\b\d{4}-\d{4}\b/g;
const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".txt", ".md"]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactIdentifiers(text: string): string {
  const { names, branches } = customerIdentifiers();
  let out = text.replace(ACCOUNT_NUMBER, "[account number]");
  for (const name of names) out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), "[member name]");
  for (const branch of branches) out = out.replace(new RegExp(`\\b${escapeRegExp(branch)}\\b`, "g"), "[branch]");
  return out;
}

/** The same identifiers, for masking at the moment a screenshot is taken. */
export function screenshotMask(): ScreenshotMask {
  const { names, branches } = customerIdentifiers();
  return { texts: [...names, ...branches], patterns: [new RegExp(ACCOUNT_NUMBER.source)] };
}

/** Rewrites every text file under `dir` in place, and returns the files that changed. */
export function redactEvidenceDir(dir: string): string[] {
  const changed: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      changed.push(...redactEvidenceDir(path));
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(path))) continue;
    const before = readFileSync(path, "utf8");
    const after = redactIdentifiers(before);
    if (after !== before) {
      writeFileSync(path, after, "utf8");
      changed.push(path);
    }
  }
  return changed;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write("usage: tsx scripts/evidence-redaction.ts <evidence directory>\n");
    process.exitCode = 1;
  } else {
    const changed = redactEvidenceDir(dir);
    process.stdout.write(`redacted ${changed.length} file(s) under ${dir}\n`);
  }
}
