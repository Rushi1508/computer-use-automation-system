/**
 * Legitimate answers recognised by absence, and the rules that keep absence
 * from ever being mistaken for an answer when it is not one.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../apps/legacy-demo/server.js";
import { parseReview, reviseCapability, RevisionError } from "../src/compiler/revise.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import { detectorHolds } from "../src/locator/match.js";
import type { Action, Observation, ObservedElement, Surface } from "../src/perception/types.js";
import { launchWebSurface } from "../src/perception/web-playwright.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { replay, type ReplayResult } from "../src/replay/engine.js";
import { type Capability, CapabilitySchema, parseCapability } from "../src/schema/capability.js";

const SCRATCH = join(".runs", "__test_outcomes__");
const ORIGIN = "http://127.0.0.1:4173";

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const V1_FILE = join("capabilities", "lookup_member_savings_balance.v1.json");
const V2_FILE = join("capabilities", "lookup_member_savings_balance.v2.json");
const REVIEW_FILE = join("capabilities", "reviews", "lookup_member_savings_balance.v2.json");

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

// --- Screens -------------------------------------------------------------------------

function cell(nodeId: number, row: string, column: string, text: string, framePath = ["main"]): ObservedElement {
  return {
    nodeId,
    actionable: false,
    role: "text",
    name: text,
    value: null,
    enabled: true,
    visible: true,
    framePath,
    anchorText: row,
    grid: { columnHeader: column, rowTexts: [row] },
    hints: { tag: "td", inputType: null, domId: null, fieldName: null },
  };
}

const button = (nodeId: number, name: string): ObservedElement => ({
  nodeId,
  actionable: true,
  role: "button",
  name,
  value: null,
  enabled: true,
  visible: true,
  framePath: ["main"],
  anchorText: null,
  hints: { tag: "input", inputType: "submit", domId: null, fieldName: null },
});

function screen(elements: ObservedElement[], tree = ""): Observation {
  return { url: `${ORIGIN}/`, title: "MERIDIAN CORE", framePaths: [[], ["main"]], elements, tree, capturedAt: "", warnings: [] };
}

const CHECKING = cell(1, "Checking", "Balance", "$1,902.44");
const SAVINGS = cell(2, "Savings", "Balance", "$14,820.37");
const SECOND_SAVINGS = cell(3, "Savings", "Balance", "$500.00");

const CHECKING_ONLY = screen([CHECKING]);
const WITH_SAVINGS = screen([CHECKING, SAVINGS]);
const TWO_SAVINGS = screen([CHECKING, SAVINGS, SECOND_SAVINGS]);
const LOADING = screen([], "# frame: main\n- text: Balance inquiry is loading");

// --- A minimal capability --------------------------------------------------------------

const READ_SAVINGS = {
  index: 0,
  intent: "Read the savings balance",
  action: "read",
  target: {
    description: "the Balance cell in the Savings row",
    framePath: ["main"],
    actionable: false,
    strategies: [{ strategy: { kind: "grid_cell", column: "Balance", rowContains: "Savings" }, confidence: 0.92, rationale: "fixture" }],
  },
  outputName: "savingsBalance",
  risk: "safe_reversible",
};

const NO_SAVINGS = {
  code: "NO_SAVINGS_ACCOUNT",
  description: "No savings account.",
  absentTarget: { step: 0, screenReady: { kind: "grid_column", column: "Balance", framePath: ["main"] } },
};

function fixture(overrides: Record<string, unknown> = {}): Capability {
  return CapabilitySchema.parse({
    schemaVersion: 1,
    id: "fixture_savings",
    version: 1,
    name: "fixture",
    description: "fixture",
    surface: { kind: "legacy_web", entrypoint: `${ORIGIN}/`, appProfileId: "meridian_core" },
    lineage: {},
    inputs: [],
    outputs: [{ name: "savingsBalance", type: "string", description: "Balance", sensitivity: "none", fromStep: 0 }],
    steps: [READ_SAVINGS],
    successCheckpoint: { description: "grid", detector: { kind: "grid_column", column: "Balance" } },
    knownOutcomes: [NO_SAVINGS],
    provenance: { discoveryRunId: "none", goal: "fixture", model: "none", recordedAt: "none", tracedSteps: 0 },
    ...overrides,
  });
}

/** Plays back screens in order, repeating the last. */
function scripted(screens: Observation[]): Surface & { readonly acts: Action[] } {
  const acts: Action[] = [];
  let i = 0;
  return {
    acts,
    observe: async () => screens[Math.min(i++, screens.length - 1)]!,
    act: async (action) => {
      acts.push(action);
      return action.kind === "read" ? { ok: true, text: "$14,820.37" } : { ok: true };
    },
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
  };
}

function run(capability: Capability, surface: Surface, stepTimeoutMs = 2_000): Promise<ReplayResult> {
  return replay({
    capability,
    inputs: {},
    surface,
    policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)),
    evidence: new EvidenceBus(newRunId("outcomes"), SCRATCH),
    stepTimeoutMs,
    pollMs: 10,
    escalation: async () => {
      throw new Error("a business outcome must never be escalated");
    },
  });
}

// --- Schema -----------------------------------------------------------------------

describe("absence outcome schema", () => {
  const rejects = (knownOutcomes: unknown[], steps: unknown[] = [READ_SAVINGS]) =>
    expect(() => fixture({ knownOutcomes, steps })).toThrow();

  it("accepts a scoped absence outcome with positive readiness", () => {
    expect(fixture().knownOutcomes[0]).toMatchObject({ code: "NO_SAVINGS_ACCOUNT", terminal: true });
  });

  it("refuses text_absent as proof that a screen has rendered", () => {
    rejects([{ ...NO_SAVINGS, absentTarget: { step: 0, screenReady: { kind: "text_absent", text: "Loading" } } }]);
  });

  it("refuses an absence outcome for a step that does not exist or has no target", () => {
    rejects([{ ...NO_SAVINGS, absentTarget: { ...NO_SAVINGS.absentTarget, step: 7 } }]);
    rejects([NO_SAVINGS], [{ index: 0, intent: "wait", action: "wait", risk: "safe_reversible", waitMs: 5 }]);
  });

  it("refuses an outcome that mixes a screen detector with an absent target, instead of silently dropping half", () => {
    rejects([{ ...NO_SAVINGS, detector: { kind: "text_present", text: "Balance" } }]);
  });

  it("refuses duplicate codes and scoping to steps that do not exist", () => {
    rejects([NO_SAVINGS, NO_SAVINGS]);
    rejects([{ code: "X", description: "x", detector: { kind: "text_present", text: "x" }, atSteps: [3] }]);
  });
});

describe("grid_column detector", () => {
  it("holds for a rendered cell under that header, not for the word in prose", () => {
    expect(detectorHolds({ kind: "grid_column", column: "Balance" }, CHECKING_ONLY)).toBe(true);
    expect(detectorHolds({ kind: "grid_column", column: "Balance", framePath: ["main"] }, CHECKING_ONLY)).toBe(true);
    expect(detectorHolds({ kind: "grid_column", column: "Balance", framePath: [] }, CHECKING_ONLY)).toBe(false);
    expect(detectorHolds({ kind: "text_present", text: "Balance" }, LOADING)).toBe(true);
    expect(detectorHolds({ kind: "grid_column", column: "Balance" }, LOADING)).toBe(false);
  });
});

// --- Replay ------------------------------------------------------------------------

describe("replay concludes absence only when it is conclusive", () => {
  it("returns the outcome when the grid has rendered and the row is absent on consecutive looks", async () => {
    const surface = scripted([CHECKING_ONLY]);
    const result = await run(fixture(), surface);
    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.outcome.code).toBe("NO_SAVINGS_ACCOUNT");
    expect(result.atStep).toBe(0);
    expect(result.outcome.basis).toContain("2 consecutive observations");
    expect(result.outcome.basis).toContain("grid_cell no match");
    expect(surface.acts.map((a) => a.kind)).toEqual(["navigate"]);
  });

  it("does not answer early when the row arrives on the confirming look", async () => {
    const result = await run(fixture(), scripted([CHECKING_ONLY, WITH_SAVINGS]));
    expect(result.status).toBe("succeeded");
  });

  it("never concludes anything before the grid has rendered", async () => {
    const result = await run(fixture(), scripted([LOADING]), 150);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.kind).toBe("target_not_found");
  });

  it("gives a first conclusive sighting at the deadline one confirming look", async () => {
    const result = await run(fixture(), scripted([CHECKING_ONLY]), 0);
    expect(result.status).toBe("business_outcome");
  });

  it("reports two matching rows as ambiguity, promptly, never as absence and never as a guess", async () => {
    const surface = scripted([TWO_SAVINGS]);
    const result = await run(fixture(), surface, 10_000);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("target_ambiguous");
    expect(result.failure.expected).toContain("2 matches");
    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(surface.acts.some((a) => a.kind === "read")).toBe(false);
  });

  it("classifies ambiguity at the timeout too, for steps without an absence outcome", async () => {
    const result = replay({
      capability: fixture({ knownOutcomes: [] }),
      inputs: {},
      surface: scripted([TWO_SAVINGS]),
      policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)),
      evidence: new EvidenceBus(newRunId("outcomes"), SCRATCH),
      stepTimeoutMs: 100,
      pollMs: 10,
    });
    const settled = await result;
    expect(settled.status === "failed" && settled.failure.kind).toBe("target_ambiguous");
  });

  it("returns the original failure when the escalation channel itself fails", async () => {
    // run() wires an escalation handler that throws, standing in for an operator desk that is down.
    const result = await run(fixture(), scripted([LOADING]), 100);
    expect(result.status === "failed" && result.failure.kind).toBe("target_not_found");
    expect(result.interventions).toEqual([]);
  });

  it("never runs an irreversible step when no approval could be obtained", async () => {
    const openAccount = {
      index: 0,
      intent: "Open the account",
      action: "click",
      target: { description: "Open Account", framePath: ["main"], actionable: true, strategies: [{ strategy: { kind: "role_name", role: "button", name: "Open Account" }, confidence: 0.95, rationale: "fixture" }] },
      risk: "risky_irreversible",
    };
    const surface = scripted([screen([button(4, "Open Account")])]);
    const result = await run(fixture({ steps: [openAccount], outputs: [], knownOutcomes: [] }), surface);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("confirmation_refused");
    expect(result.failure.observed).toContain("no approval could be obtained");
    expect(surface.acts.map((a) => a.kind)).toEqual(["navigate"]);
  });

  it("counts a scoped screen outcome only at its own steps", async () => {
    const search = {
      index: 0,
      intent: "Search",
      action: "click",
      target: { description: "Search", framePath: ["main"], actionable: true, strategies: [{ strategy: { kind: "role_name", role: "button", name: "Search" }, confidence: 0.95, rationale: "fixture" }] },
      risk: "safe_reversible",
    };
    const noAccounts = { code: "NO_OPEN_ACCOUNTS", description: "none", detector: { kind: "text_present", text: "No open accounts." } };
    const tree = "# frame: main\n- text: No open accounts.";
    const page = screen([button(9, "Search")], tree);

    const scoped = fixture({ steps: [search, { ...READ_SAVINGS, index: 1 }], outputs: [], knownOutcomes: [{ ...noAccounts, atSteps: [1] }] });
    const surface = scripted([page]);
    const result = await run(scoped, surface);
    expect(result.status === "business_outcome" && [result.outcome.code, result.atStep]).toEqual(["NO_OPEN_ACCOUNTS", 1]);
    expect(surface.acts.map((a) => a.kind)).toEqual(["navigate", "click"]);

    const unscoped = await run(fixture({ steps: [search, { ...READ_SAVINGS, index: 1 }], outputs: [], knownOutcomes: [noAccounts] }), scripted([page]));
    expect(unscoped.status === "business_outcome" && unscoped.atStep).toBe(0);
  });
});

// --- Revision ------------------------------------------------------------------------

describe("reviewed revisions", () => {
  const v1 = parseCapability(readJson(V1_FILE));
  const review = parseReview(readJson(REVIEW_FILE));

  it("regenerates the committed v2 exactly from v1 and its review", () => {
    expect(reviseCapability(v1, review)).toEqual(parseCapability(readJson(V2_FILE)));
  });

  it("produces a new draft version with the revision recorded, and leaves v1 untouched", () => {
    const v2 = reviseCapability(v1, review);
    expect(v2.version).toBe(2);
    expect(v2.approvalState).toBe("draft");
    expect(v2.provenance.revisions).toHaveLength(1);
    expect(v2.provenance.revisions[0]?.changes).toHaveLength(2);
    expect(v2.steps).toEqual(v1.steps);
    expect(v1.knownOutcomes.map((o) => o.code)).not.toContain("NO_SAVINGS_ACCOUNT");
  });

  it("refuses a review written against another capability or version, or re-adding a code", () => {
    expect(() => reviseCapability(v1, { ...review, baseVersion: 2 })).toThrow(RevisionError);
    expect(() => reviseCapability(v1, { ...review, capabilityId: "other" })).toThrow(RevisionError);
    expect(() => reviseCapability(reviseCapability(v1, review), { ...review, baseVersion: 2 })).toThrow(/already exists/);
  });

  it("keeps customer data out of the revised artifact", () => {
    const text = readFileSync(V2_FILE, "utf8");
    for (const literal of ["12345", "23456", "67890", "Dolores", "Teddy", "14,820"]) expect(text).not.toContain(literal);
  });
});

/**
 * Every committed review, not just the first one.
 *
 * Applying a review is deterministic, so each revised artifact in the
 * repository must be exactly what its base and its review produce. This is what
 * makes a revision auditable: a reviewer can re-derive the artifact rather than
 * taking the committed file's word for what was changed.
 */
describe("every committed revision regenerates from its base and review", () => {
  const reviewDir = join("capabilities", "reviews");
  const reviewFiles = readdirSync(reviewDir).filter((name) => name.endsWith(".json"));

  it("finds the reviews", () => expect(reviewFiles.length).toBeGreaterThan(0));

  for (const name of reviewFiles) {
    it(name, () => {
      const review = parseReview(readJson(join(reviewDir, name)));
      const base = parseCapability(readJson(join("capabilities", `${review.capabilityId}.v${review.baseVersion}.json`)));
      const committed = parseCapability(
        readJson(join("capabilities", `${review.capabilityId}.v${review.baseVersion + 1}.json`)),
      );
      expect(reviseCapability(base, review)).toEqual(committed);
    });
  }
});

// --- Against the real application -------------------------------------------------------

describe("lookup v2 against the demo application", () => {
  let server: Server;
  let base = "";
  const v2 = parseCapability(readJson(V2_FILE));

  beforeAll(async () => {
    server = await new Promise<Server>((resolve) => {
      const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  async function lookup(memberId: string, seedSecondSavings = false): Promise<ReplayResult> {
    await fetch(`${base}/_control/reset`, { method: "POST" });
    if (seedSecondSavings) {
      await fetch(`${base}/_control/account`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ memberId: "12345", type: "Savings", depositCents: "50000" }),
      });
    }
    const surface = await launchWebSurface({});
    try {
      return await replay({
        capability: v2,
        inputs: { operatorId: "op-test", password: "demo", memberId },
        surface,
        policy: new PolicyEngine(defaultPolicyConfig(base)),
        evidence: new EvidenceBus(newRunId("outcomes-live"), SCRATCH),
        entrypoint: `${base}/`,
        ...(seedSecondSavings
          ? {}
          : { escalation: async () => { throw new Error("a business outcome must never be escalated"); } }),
      });
    } finally {
      await surface.close();
    }
  }

  it("still returns the balance for a member with one savings account", async () => {
    const result = await lookup("12345");
    expect(result.status === "succeeded" && result.outputs["savingsBalance"]).toBe("$14,820.37");
  }, 60_000);

  it("answers NO_SAVINGS_ACCOUNT for a checking-only member, well inside the step timeout", async () => {
    const result = await lookup("23456");
    expect(result.status === "business_outcome" && [result.outcome.code, result.atStep]).toEqual(["NO_SAVINGS_ACCOUNT", 5]);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 60_000);

  it("answers NO_OPEN_ACCOUNTS for a member with no accounts", async () => {
    const result = await lookup("67890");
    expect(result.status === "business_outcome" && result.outcome.code).toBe("NO_OPEN_ACCOUNTS");
  }, 60_000);

  it("fails as ambiguous, escalatable, when the member has two savings accounts", async () => {
    const result = await lookup("12345", true);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("target_ambiguous");
    expect(result.failure.escalatable).toBe(true);
  }, 60_000);
});
