import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  Catalog,
  contractChange,
  heldSteps,
  latestContractChange,
  toolDescription,
  type VersionedCapability,
} from "../src/catalog/catalog.js";
import {
  exampleInvocation,
  formatCapabilityDescription,
  formatCatalogList,
} from "../src/catalog/format.js";
import { validateInputs } from "../src/replay/engine.js";
import { CapabilitySchema, invocationSchema, type Capability } from "../src/schema/capability.js";

// --- Fixtures ----------------------------------------------------------------

interface Overrides {
  readonly id?: string;
  readonly version?: number;
  readonly approvalState?: "draft" | "approved";
  readonly appProfileId?: string;
  readonly inputs?: unknown[];
  readonly outputs?: unknown[];
  readonly knownOutcomes?: unknown[];
  readonly risky?: boolean;
}

function capability(overrides: Overrides = {}): Capability {
  return CapabilitySchema.parse({
    schemaVersion: 1,
    id: overrides.id ?? "lookup_balance",
    version: overrides.version ?? 1,
    name: "Lookup balance",
    description: "Looks up a member's balance.",
    approvalState: overrides.approvalState ?? "draft",
    surface: {
      kind: "legacy_web",
      entrypoint: "http://127.0.0.1:4173/",
      appProfileId: overrides.appProfileId ?? "meridian_core",
    },
    lineage: { overrides: [] },
    inputs: overrides.inputs ?? [
      { name: "memberId", type: "string", required: true, description: "Member", sensitivity: "pii" },
      { name: "password", type: "string", required: true, description: "Password", sensitivity: "secret" },
    ],
    outputs: overrides.outputs ?? [
      { name: "balance", type: "string", description: "Balance", sensitivity: "none", fromStep: 0 },
    ],
    steps: [
      {
        index: 0,
        intent: "Read the balance",
        action: "read",
        target: {
          description: "the Balance cell",
          framePath: [],
          actionable: false,
          strategies: [
            {
              strategy: { kind: "grid_cell", column: "Balance", rowContains: "Savings" },
              confidence: 0.9,
              rationale: "fixture",
            },
          ],
        },
        outputName: "balance",
        risk: overrides.risky === true ? "risky_irreversible" : "safe_reversible",
      },
    ],
    successCheckpoint: {
      description: "The balance grid is showing",
      detector: { kind: "text_present", text: "Balance" },
    },
    knownOutcomes: overrides.knownOutcomes ?? [
      {
        code: "MEMBER_NOT_FOUND",
        description: "No member exists with the supplied ID.",
        detector: { kind: "text_present", text: "No member found for ID" },
      },
    ],
    provenance: {
      discoveryRunId: "fixture",
      goal: "fixture",
      model: "none",
      recordedAt: "2026-01-01T00:00:00Z",
      tracedSteps: 1,
    },
  });
}

const item = (cap: Capability, file?: string): VersionedCapability => ({
  capability: cap,
  file: file ?? join("capabilities", `${cap.id}.v${cap.version}.json`),
});

const roots: string[] = [];

/** Writes artifacts into a throwaway directory, named however the caller asks. */
function directory(files: Readonly<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "cua-catalog-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// --- Loading -----------------------------------------------------------------

describe("loading the catalog", () => {
  it("groups immutable versions under one id, newest last", () => {
    const catalog = Catalog.from([
      item(capability({ version: 2 })),
      item(capability({ version: 1 })),
      item(capability({ id: "open_account" })),
    ]);

    expect(catalog.entries.map((e) => e.id)).toEqual(["lookup_balance", "open_account"]);
    const entry = catalog.get("lookup_balance");
    expect(entry?.versions.map((v) => v.capability.version)).toEqual([1, 2]);
    expect(entry?.latest.capability.version).toBe(2);
  });

  it("reads a directory of artifacts and ignores the reviews subdirectory", () => {
    const root = directory({
      "lookup_balance.v1.json": capability(),
      "lookup_balance.v2.json": capability({ version: 2 }),
      "reviews/lookup_balance.v2.json": { id: "lookup_balance", targetVersion: 2 },
      "notes.txt": "not an artifact",
    });

    const catalog = Catalog.load(root);
    expect(catalog.problems).toEqual([]);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.get("lookup_balance")?.latest.capability.version).toBe(2);
  });

  it("reports an unparseable artifact instead of dropping it", () => {
    const catalog = Catalog.load(
      directory({ "lookup_balance.v1.json": capability(), "broken.v1.json": "{ not json" }),
    );

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]?.file).toContain("broken.v1.json");
  });

  it("reports an artifact whose filename disagrees with its contents", () => {
    const catalog = Catalog.load(directory({ "lookup_balance.v7.json": capability({ version: 1 }) }));

    expect(catalog.problems[0]?.message).toContain("should be named lookup_balance.v1.json");
    // Still usable: the naming is wrong, the capability is not.
    expect(catalog.get("lookup_balance")?.latest.capability.version).toBe(1);
  });

  it("refuses to choose between two files claiming the same version", () => {
    const catalog = Catalog.from([
      item(capability(), "a.json"),
      item(capability(), "b.json"),
    ]);

    expect(catalog.get("lookup_balance")?.versions).toHaveLength(1);
    expect(catalog.problems[0]?.message).toContain("duplicate");
  });

  it("lists a capability whose app profile is missing, with the reason", () => {
    const catalog = Catalog.from([item(capability({ appProfileId: "unknown_vendor" }))]);
    const entry = catalog.get("lookup_balance");

    expect(entry).toBeDefined();
    expect(entry?.blockers[0]).toContain("Unknown app profile");
    // Not offered to an agent: without the profile its outcome vocabulary is
    // gone, so a legitimate business answer would come back as a failure.
    expect(catalog.toolDefinitions()).toEqual([]);
  });

  it("survives a directory that does not exist", () => {
    const catalog = Catalog.load(join(tmpdir(), "cua-catalog-does-not-exist"));
    expect(catalog.entries).toEqual([]);
    expect(catalog.problems).toHaveLength(1);
  });
});

// --- Resolution --------------------------------------------------------------

describe("resolving a capability", () => {
  const catalog = Catalog.from([
    item(capability({ version: 1 })),
    item(capability({ version: 2 })),
    item(capability({ id: "open_account" })),
  ]);

  it("binds an unversioned reference to the newest version", () => {
    const resolution = catalog.resolve("lookup_balance");
    expect(resolution.ok && resolution.selected.capability.version).toBe(2);
  });

  it("pins the version a caller names", () => {
    const resolution = catalog.resolve("lookup_balance", 1);
    expect(resolution.ok && resolution.selected.capability.version).toBe(1);
  });

  it("says which versions exist when the pinned one does not", () => {
    const resolution = catalog.resolve("lookup_balance", 9);
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.message).toContain("v1, v2");
  });

  it("suggests near matches for an unknown id", () => {
    const resolution = catalog.resolve("lookup");
    expect(!resolution.ok && resolution.message).toContain("lookup_balance");
    expect(!resolution.ok && resolution.message).not.toContain("open_account");
  });
});

// --- The agent-facing contract ----------------------------------------------

describe("tool definitions", () => {
  it("offers one tool per capability, bound to its newest version", () => {
    const catalog = Catalog.from([item(capability({ version: 1 })), item(capability({ version: 2 }))]);
    const [tool] = catalog.toolDefinitions();

    expect(catalog.toolDefinitions()).toHaveLength(1);
    expect(tool?.name).toBe("lookup_balance");
    expect(tool?.description).toContain("(v2)");
  });

  it("generates the input schema from the same definitions that validate the artifact", () => {
    const cap = capability();
    const [tool] = Catalog.from([item(cap)]).toolDefinitions();

    expect(tool?.input_schema).toEqual(invocationSchema(cap));
    expect(tool?.input_schema["required"]).toEqual(["memberId", "password"]);
    expect(tool?.input_schema["additionalProperties"]).toBe(false);
  });

  it("names the business outcomes, so a model does not read a legitimate answer as a fault", () => {
    const description = toolDescription(capability());
    expect(description).toContain("MEMBER_NOT_FOUND");
    expect(description).toContain("do not retry");
  });

  it("warns that a draft with an irreversible step will pause for a person", () => {
    expect(toolDescription(capability({ risky: true }))).toContain("pauses for a human operator");
    expect(heldSteps(capability({ risky: true }))).toEqual([0]);
  });

  it("does not warn once the capability is approved, because nothing will pause", () => {
    const approved = capability({ risky: true, approvalState: "approved" });
    expect(heldSteps(approved)).toEqual([]);
    expect(toolDescription(approved)).not.toContain("pauses for a human operator");
  });

  it("rejects an invocation that omits a required input or invents one", () => {
    const cap = capability();
    expect(validateInputs(cap, { memberId: "12345", password: "x" })).toEqual([]);
    expect(validateInputs(cap, { password: "x" })).toEqual(["missing required input 'memberId'"]);
    expect(validateInputs(cap, { memberId: "1", password: "x", extra: "1" })).toEqual([
      "unknown input 'extra'",
    ]);
  });
});

// --- Version drift -----------------------------------------------------------

describe("contract change between versions", () => {
  const base = capability();

  it("treats a new outcome as non-breaking but reports it", () => {
    const next = capability({
      version: 2,
      knownOutcomes: [
        ...base.knownOutcomes,
        {
          code: "NO_SAVINGS_ACCOUNT",
          description: "The member has no savings account.",
          detector: { kind: "text_present", text: "No open accounts." },
        },
      ],
    });

    const change = contractChange(base, next);
    expect(change.breaking).toBe(false);
    expect(change.addedOutcomes).toEqual(["NO_SAVINGS_ACCOUNT"]);
  });

  it("flags a newly required input as breaking for existing callers", () => {
    const next = capability({
      version: 2,
      inputs: [
        ...base.inputs,
        { name: "branchId", type: "string", required: true, description: "Branch", sensitivity: "none" },
      ],
    });

    const change = contractChange(base, next);
    expect(change.breaking).toBe(true);
    expect(change.newlyRequiredInputs).toEqual(["branchId"]);
  });

  it("flags a removed output as breaking", () => {
    const change = contractChange(base, capability({ version: 2, outputs: [] }));
    expect(change.breaking).toBe(true);
    expect(change.removedOutputs).toEqual(["balance"]);
  });

  it("compares the newest version against the one before it, and nothing at v1", () => {
    const single = Catalog.from([item(base)]).get("lookup_balance");
    expect(single !== undefined && latestContractChange(single)).toBeNull();

    const entry = Catalog.from([item(base), item(capability({ version: 2, outputs: [] }))]).get("lookup_balance");
    expect(entry !== undefined && latestContractChange(entry)?.from).toBe(1);
  });
});

// --- Rendering ---------------------------------------------------------------

describe("rendering", () => {
  it("shows the contract and the version history in a listing", () => {
    const catalog = Catalog.from([item(capability()), item(capability({ version: 2 }))]);
    const text = formatCatalogList(catalog, "capabilities");

    expect(text).toContain("lookup_balance  v2 (draft)");
    expect(text).toContain("memberId: string (required, pii)");
    expect(text).toContain("password: string (required, secret)");
    expect(text).toContain("MEMBER_NOT_FOUND");
    expect(text).toContain("versions: v1, v2");
  });

  it("marks a breaking change and an unusable capability in the listing", () => {
    const breaking = Catalog.from([item(capability()), item(capability({ version: 2, outputs: [] }))]);
    expect(formatCatalogList(breaking, "capabilities")).toContain("may break");

    const broken = Catalog.from([item(capability({ appProfileId: "unknown_vendor" }))]);
    expect(formatCatalogList(broken, "capabilities")).toContain("not replayable");
  });

  it("does not hide files it could not read", () => {
    const catalog = Catalog.load(directory({ "broken.v1.json": "{ not json" }));
    expect(formatCatalogList(catalog, "capabilities")).toContain("could not be used");
  });

  it("describes one version in full, including how it differs from the last", () => {
    const entry = Catalog.from([
      item(capability()),
      item(capability({ version: 2, outputs: [] })),
    ]).get("lookup_balance");
    if (entry === undefined) throw new Error("entry missing");

    const text = formatCapabilityDescription(entry, entry.latest);
    expect(text).toContain("lookup_balance v2");
    expect(text).toContain("meridian_core — MERIDIAN CORE");
    expect(text).toContain("Business outcomes (exit code 2, not failures)");
    expect(text).toContain("BREAKING for existing callers");
    expect(text).toContain("Invocation schema");
  });

  it("says plainly that a capability with no profile cannot be replayed", () => {
    const entry = Catalog.from([item(capability({ appProfileId: "unknown_vendor" }))]).get("lookup_balance");
    if (entry === undefined) throw new Error("entry missing");
    expect(formatCapabilityDescription(entry, entry.latest)).toContain("cannot be replayed");
  });

  it("takes secrets from the environment in the example command", () => {
    const command = exampleInvocation(capability());
    expect(command).toContain("--input memberId=<string>");
    expect(command).toContain("--input-env password=PASSWORD");
  });
});

// --- The committed artifacts -------------------------------------------------

describe("the shipped catalog", () => {
  it("loads every committed artifact without a problem", () => {
    const catalog = Catalog.load();
    expect(catalog.problems).toEqual([]);
    expect(catalog.entries.map((e) => e.id)).toContain("lookup_member_savings_balance");
    expect(catalog.toolDefinitions().length).toBe(catalog.entries.length);
  });
});

describe("approval in the catalog", () => {
  it("reports an artifact that approves itself, and offers it as the draft it is", () => {
    const catalog = Catalog.load(directory({ "lookup_balance.v1.json": capability({ approvalState: "approved", risky: true }) }));
    const entry = catalog.get("lookup_balance");

    expect(entry?.latest.capability.approvalState).toBe("draft");
    expect(catalog.problems.map((p) => p.message).join("\n")).toContain("declares itself approved");
    expect(entry === undefined ? "" : toolDescription(entry.latest.capability)).toContain("pauses for a human operator");
  });
});
