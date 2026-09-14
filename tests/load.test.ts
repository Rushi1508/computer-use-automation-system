/**
 * The artifact loader. Every command reads artifacts through it, so it decides
 * both what a caller is told when a file is wrong and whether an artifact's
 * approval is honoured.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { approvalRecordFor, APPROVALS_DIR, capabilityDigest } from "../src/schema/approval.js";
import { parseCapability } from "../src/schema/capability.js";
import { readCapabilityFile } from "../src/schema/load.js";

const SOURCE = join("capabilities", "open_sub_account.v2.json");
const IRREVERSIBLE_STEP = 8;

type Artifact = Record<string, unknown> & {
  approvalState: string;
  steps: { action: string; risk: string }[];
  knownOutcomes: unknown[];
};
const artifact = (): Artifact => JSON.parse(readFileSync(SOURCE, "utf8")) as Artifact;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "cua-load-"));
  roots.push(root);
  return root;
}

function write(root: string, name: string, content: unknown): string {
  const file = join(root, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  return file;
}

function problemOf(file: string): string {
  const loaded = readCapabilityFile(file);
  if (loaded.ok) throw new Error("expected the file to be rejected");
  return loaded.problem;
}

describe("a file that is not a usable artifact is described, not thrown", () => {
  it("malformed JSON", () => {
    expect(problemOf(write(scratch(), "a.json", '{"schemaVersion": 1, "id": "oops",'))).toMatch(/^is not valid JSON \(/);
  });

  it("an empty file", () => {
    expect(problemOf(write(scratch(), "a.json", "  \n"))).toBe("is empty");
  });

  it("a file that does not exist, without echoing an absolute path", () => {
    expect(problemOf(join(scratch(), "missing.json"))).toBe("does not exist");
  });

  it("a directory where a file was expected", () => {
    expect(problemOf(scratch())).toBe("is a directory, not a file");
  });

  it("the wrong schema version, naming the field", () => {
    expect(problemOf(write(scratch(), "a.json", { ...artifact(), schemaVersion: 2 }))).toContain("schemaVersion:");
  });

  it("an unknown action, naming the step, without the raw validation dump", () => {
    const bad = artifact();
    bad.steps[3]!.action = "teleport";
    const problem = problemOf(write(scratch(), "a.json", bad));
    expect(problem).toContain("steps[3].action:");
    expect(problem).not.toContain("ZodError");
    expect(problem).not.toContain('"code"');
  });

  it("a missing required field", () => {
    const bad: Record<string, unknown> = artifact();
    delete bad["name"];
    expect(problemOf(write(scratch(), "a.json", bad))).toContain("name:");
  });

  it("a cross-field reference to a step that does not exist", () => {
    const bad = artifact();
    bad.knownOutcomes.push({
      code: "PHANTOM",
      description: "Refers to a step that is not there.",
      detector: { kind: "text_present", text: "Phantom" },
      atSteps: [99],
    });
    expect(problemOf(write(scratch(), "a.json", bad))).toContain("step 99 does not exist");
  });
});

describe("approval is honoured only through a matching record", () => {
  function place(content: object, approvedContent?: object): string {
    const root = scratch();
    const file = write(root, "open_sub_account.v2.json", content);
    if (approvedContent !== undefined) {
      mkdirSync(join(root, APPROVALS_DIR));
      write(root, join(APPROVALS_DIR, "open_sub_account.v2.json"), approvalRecordFor(parseCapability(approvedContent), "reviewer-test", ""));
    }
    return file;
  }

  it("loads an unapproved artifact as a draft, with nothing to report", () => {
    const loaded = readCapabilityFile(place(artifact()));
    expect(loaded.ok && loaded.capability.approvalState).toBe("draft");
    expect(loaded.ok && loaded.warnings).toEqual([]);
  });

  it("does not let an artifact approve itself", () => {
    const loaded = readCapabilityFile(place({ ...artifact(), approvalState: "approved" }));
    expect(loaded.ok && loaded.capability.approvalState).toBe("draft");
    expect(loaded.ok && loaded.warnings[0]).toContain("declares itself approved");
  });

  it("approves an artifact whose content matches its record, without the artifact having to say so", () => {
    const content = artifact();
    const loaded = readCapabilityFile(place(content, content));
    expect(loaded.ok && loaded.capability.approvalState).toBe("approved");
    expect(loaded.ok && loaded.warnings).toEqual([]);
  });

  it("voids the approval when the artifact is edited afterwards, such as a risky step downgraded", () => {
    const tampered = artifact();
    tampered.steps[IRREVERSIBLE_STEP]!.risk = "safe_reversible";
    const loaded = readCapabilityFile(place(tampered, artifact()));
    expect(loaded.ok && loaded.capability.approvalState).toBe("draft");
    expect(loaded.ok && loaded.warnings[0]).toContain("digest mismatch");
  });

  it("depends on content, not formatting", () => {
    const content = artifact();
    const root = scratch();
    writeFileSync(join(root, "open_sub_account.v2.json"), JSON.stringify(content), "utf8");
    mkdirSync(join(root, APPROVALS_DIR));
    write(root, join(APPROVALS_DIR, "open_sub_account.v2.json"), approvalRecordFor(parseCapability(content), "reviewer-test", ""));

    const reordered = Object.fromEntries(Object.entries(content).reverse());
    expect(capabilityDigest(parseCapability(reordered))).toBe(capabilityDigest(parseCapability(content)));
    const loaded = readCapabilityFile(join(root, "open_sub_account.v2.json"));
    expect(loaded.ok && loaded.capability.approvalState).toBe("approved");
  });

  it("treats a malformed approval record as no approval", () => {
    const root = scratch();
    const file = write(root, "open_sub_account.v2.json", artifact());
    mkdirSync(join(root, APPROVALS_DIR));
    write(root, join(APPROVALS_DIR, "open_sub_account.v2.json"), { capabilityId: "open_sub_account" });
    const loaded = readCapabilityFile(file);
    expect(loaded.ok && loaded.capability.approvalState).toBe("draft");
    expect(loaded.ok && loaded.warnings[0]).toContain("malformed approval record");
  });
});
