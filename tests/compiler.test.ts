import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DiscoveryResult, TraceStep } from "../src/agent/loop.js";
import { compile } from "../src/compiler/compile.js";
import { deriveStrategies, NoStrategyError } from "../src/compiler/strategies.js";
import { locatorEvidence } from "../src/locator/match.js";
import type { ObservedElement } from "../src/perception/types.js";
import { appProfile } from "../src/schema/app-profile.js";
import { CapabilitySchema, invocationSchema, parseCapability } from "../src/schema/capability.js";

const OPTS = {
  id: "test_capability",
  name: "Test capability",
  description: "A capability compiled in a test.",
  appProfileId: "meridian_core",
};

function el(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    nodeId: 0,
    actionable: true,
    role: "textbox",
    name: "Member ID",
    value: null,
    enabled: true,
    visible: true,
    framePath: ["main"],
    anchorText: null,
    hints: { tag: "input", inputType: "text", domId: null, fieldName: null },
    ...overrides,
  };
}

/** A trace step without locator evidence, as recorded before evidence existed. */
function bareStep(overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    index: 0,
    intent: "do the thing",
    action: { kind: "fill", nodeId: 0, value: "12345" },
    target: el(),
    urlBefore: "http://app/",
    titleBefore: "Member Search",
    urlAfter: "http://app/",
    policy: { verdict: "allow", rule: "risk-classification", reason: "safe" },
    ok: true,
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A trace step with locator evidence measured against a screen holding only its target. */
function step(overrides: Partial<TraceStep> = {}): TraceStep {
  const s = bareStep(overrides);
  if (s.target === undefined || "locatorEvidence" in overrides) return s;
  return { ...s, locatorEvidence: locatorEvidence(s.target, [s.target]) };
}

function result(
  trace: TraceStep[],
  goal: string,
  checkpoints: DiscoveryResult["checkpoints"] = [],
): DiscoveryResult {
  return {
    status: "succeeded",
    summary: "done",
    goal,
    entrypoint: "http://app/",
    trace,
    checkpoints,
    outputs: {},
    steps: trace.length,
    elapsedMs: 100,
    usage: { turns: 1, costUsd: 0, cacheWorking: true },
  };
}

const passwordField = el({
  name: "Password",
  hints: { tag: "input", inputType: "password", domId: null, fieldName: "password" },
});

describe("parameterisation — values never enter the artifact", () => {
  it("promotes a value named in the goal to a typed input", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    expect(capability.inputs.map((i) => i.name)).toEqual(["memberId"]);
    expect(capability.steps[0]?.value).toEqual({ param: "memberId" });
  });

  it("keeps a value the goal never mentions as a literal", () => {
    const s = step({
      action: { kind: "select", nodeId: 0, value: "Savings" },
      target: el({ role: "combobox", name: "Account Type" }),
    });
    const { capability } = compile(result([s], "open a sub-account for the member"), OPTS);
    expect(capability.inputs).toHaveLength(0);
    expect(capability.steps[0]?.value).toEqual({ literal: "Savings" });
  });

  it("always parameterises a password, however the goal was phrased", () => {
    const s = step({ action: { kind: "fill", nodeId: 0, value: "hunter2" }, target: passwordField });
    const { capability } = compile(result([s], "sign on and do something"), OPTS);
    expect(capability.inputs[0]?.name).toBe("password");
    expect(capability.inputs[0]?.sensitivity).toBe("secret");
  });

  it("never writes a recorded secret anywhere in the artifact", () => {
    const s = step({ action: { kind: "fill", nodeId: 0, value: "hunter2" }, target: passwordField });
    const { capability } = compile(result([s], "sign on with password hunter2"), OPTS);
    expect(JSON.stringify(capability)).not.toContain("hunter2");
  });

  it("stores an example only for non-sensitive inputs", () => {
    const sensitive = compile(result([step()], "look up member 12345"), OPTS).capability;
    expect(sensitive.inputs[0]?.sensitivity).toBe("pii");
    expect(sensitive.inputs[0]?.example).toBeUndefined();

    const benign = compile(
      result(
        [step({ action: { kind: "fill", nodeId: 0, value: "quarterly" }, target: el({ name: "Report Period" }) })],
        "run the quarterly report",
      ),
      OPTS,
    ).capability;
    expect(benign.inputs[0]?.sensitivity).toBe("none");
    expect(benign.inputs[0]?.example).toBe("quarterly");
  });

  it("templates this run's values out of free text", () => {
    // The artifact describes the procedure, not one execution of it.
    const s = step({ intent: "Search for member 12345" });
    const { capability } = compile(result([s], "look up member 12345"), { ...OPTS, description: undefined as never });
    expect(capability.steps[0]?.intent).toBe("Search for member {memberId}");
    expect(capability.provenance.goal).toBe("look up member {memberId}");
    expect(JSON.stringify(capability)).not.toContain("12345");
  });
});

describe("locator strategies", () => {
  it("ranks role+name first when it is unique on screen", () => {
    const target = el({ hints: { tag: "input", inputType: "text", domId: "ctl00_x", fieldName: "memberId" } });
    const ranked = deriveStrategies(target, locatorEvidence(target, [target]));
    expect(ranked[0]?.strategy.kind).toBe("role_name");
    expect(ranked[0]?.confidence).toBeGreaterThan(0.9);
    expect(ranked.at(-1)?.strategy.kind).toBe("dom_id");
  });

  it("demotes a strategy that matched more than one element on the recorded screen", () => {
    const a = el({ nodeId: 0, name: "Search" });
    const b = el({ nodeId: 1, name: "Search" });
    const roleName = deriveStrategies(a, locatorEvidence(a, [a, b])).find((r) => r.strategy.kind === "role_name");
    expect(roleName?.confidence).toBeLessThan(0.6);
    expect(roleName?.rationale).toContain("2 elements");
  });

  it("makes anchored targeting primary for a control with no accessible name", () => {
    const target = el({
      name: "",
      anchorText: "Initial Deposit",
      hints: { tag: "input", inputType: "text", domId: null, fieldName: "deposit" },
    });
    const ranked = deriveStrategies(target, locatorEvidence(target, [target]));
    expect(ranked[0]?.strategy.kind).toBe("anchored_row");
    expect(ranked[0]?.rationale).toContain("no accessible name");
  });

  it("uses both grid coordinates where a row anchor alone is ambiguous", () => {
    // The shape of a real defect: the account-number and balance cells share
    // the "Savings" neighbour, so anchoring on the row matches both.
    const balance = el({
      nodeId: 2,
      actionable: false,
      role: "text",
      name: "",
      anchorText: "Savings",
      grid: { columnHeader: "Balance", rowTexts: ["0002-8891", "Savings"] },
      hints: { tag: "td", inputType: null, domId: null, fieldName: null },
    });
    const account = { ...balance, nodeId: 1, grid: { columnHeader: "Account", rowTexts: ["Savings", "$1"] } };

    const ranked = deriveStrategies(balance, locatorEvidence(balance, [account, balance]));
    expect(ranked[0]).toMatchObject({ strategy: { kind: "grid_cell", column: "Balance", rowContains: "Savings" }, confidence: 0.92 });
    expect(ranked.find((r) => r.strategy.kind === "anchored_row")?.confidence).toBeLessThan(0.5);
  });

  it("reduces confidence when uniqueness was never recorded", () => {
    const ranked = deriveStrategies(el(), []);
    expect(ranked[0]?.confidence).toBeLessThan(0.95);
    expect(ranked[0]?.rationale).toContain("not recorded");
  });

  it("refuses to emit a target it cannot identify", () => {
    const anonymous = el({ name: "", anchorText: null, hints: { tag: "input", inputType: "text", domId: null, fieldName: null } });
    expect(() => compile(result([step({ target: anonymous })], "goal"), OPTS)).toThrow(NoStrategyError);
  });
});

describe("contract, checkpoints and outcomes", () => {
  const balanceRead = (): TraceStep =>
    step({
      action: { kind: "read", nodeId: 0 },
      outputName: "savingsBalance",
      extracted: "$14,820.37",
      titleBefore: "Member 12345",
      target: el({
        actionable: false,
        role: "text",
        name: "",
        anchorText: "Savings",
        value: "$14,820.37",
        grid: { columnHeader: "Balance", rowTexts: ["0002-8891", "Savings"] },
        hints: { tag: "td", inputType: null, domId: null, fieldName: null },
      }),
    });

  it("declares an output for each read step", () => {
    const { capability } = compile(result([balanceRead()], "read the savings balance"), OPTS);
    expect(capability.outputs[0]).toMatchObject({ name: "savingsBalance", fromStep: 0 });
  });

  it("merges the application's outcome vocabulary from its profile", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    expect(capability.knownOutcomes.map((o) => o.code)).toContain("MEMBER_NOT_FOUND");
    expect(capability.knownOutcomes).toEqual(appProfile("meridian_core").knownOutcomes);
  });

  it("derives a success checkpoint from structure, not from this run's data", () => {
    const { capability } = compile(result([balanceRead()], "read savings for 12345"), OPTS);
    expect(capability.successCheckpoint.detector).toEqual({ kind: "text_present", text: "Balance" });
    expect(JSON.stringify(capability.successCheckpoint)).not.toMatch(/12345|14,820/);
  });

  it("attaches only checkpoints that were verified on screen", () => {
    const { capability, notes } = compile(
      result([step(), balanceRead()], "look up member 12345", [
        { afterStep: 0, description: "Member 12345 (Dolores Abernathy) is showing", verifiedText: null },
        { afterStep: 1, description: 'The "Balance" column is showing', verifiedText: "Balance" },
      ]),
      OPTS,
    );
    expect(capability.steps[0]?.checkpoint).toBeUndefined();
    expect(capability.steps[1]?.checkpoint?.detector).toEqual({ kind: "text_present", text: "Balance" });
    expect(notes.some((n) => n.includes("was not attached"))).toBe(true);
    expect(JSON.stringify(capability)).not.toContain("Dolores");
  });

  it("identifies the authentication prefix for session recovery", () => {
    const trace = [
      step({ index: 0, action: { kind: "fill", nodeId: 0, value: "op-demo" }, target: el({ name: "Operator ID" }) }),
      step({ index: 1, action: { kind: "fill", nodeId: 0, value: "pw-value" }, target: passwordField }),
      step({ index: 2, action: { kind: "click", nodeId: 0 }, target: el({ role: "button", name: "Sign On" }) }),
      step({ index: 3 }),
    ];
    const { capability } = compile(result(trace, "sign on as op-demo and look up member 12345"), OPTS);
    expect(capability.authentication).toEqual({ throughStep: 2 });
  });

  it("carries the risk class the policy engine assigned", () => {
    const s = step({
      action: { kind: "click", nodeId: 0 },
      target: el({ role: "button", name: "Open Account" }),
      policy: { verdict: "confirm", rule: "risky-irreversible", reason: "irreversible" },
    });
    const { capability } = compile(result([s], "open an account"), OPTS);
    expect(capability.steps[0]?.risk).toBe("risky_irreversible");
  });

  it("flags a trace recorded without locator evidence", () => {
    const { notes } = compile(result([bareStep()], "look up member 12345"), OPTS);
    expect(notes.some((n) => n.includes("without locator evidence"))).toBe(true);
  });

  it("is deterministic: the same trace compiles to the same artifact", () => {
    const trace = [step(), balanceRead()];
    const first = compile(result(trace, "look up member 12345"), OPTS).capability;
    const second = compile(result(trace, "look up member 12345"), OPTS).capability;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("refuses to compile a run that did not reach its goal", () => {
    const failed = { ...result([step()], "goal"), status: "escalated" as const };
    expect(() => compile(failed, OPTS)).toThrow(/Refusing to compile/);
  });

  it("starts every capability as a draft", () => {
    expect(compile(result([step()], "look up member 12345"), OPTS).capability.approvalState).toBe("draft");
  });
});

describe("the artifact is a contract an agent can call", () => {
  it("generates an invocation schema from the same definitions that validate it", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    const schema = invocationSchema(capability) as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(Object.keys(schema["properties"] as object)).toEqual(["memberId"]);
    expect(schema["required"]).toEqual(["memberId"]);
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("round-trips through the schema after serialisation", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    expect(parseCapability(JSON.parse(JSON.stringify(capability)))).toEqual(capability);
  });

  it("rejects an artifact with a malformed identifier", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    expect(() => CapabilitySchema.parse({ ...capability, id: "Not Snake Case" })).toThrow();
  });
});

const COMMITTED = "capabilities/lookup_member_savings_balance.v1.json";

describe.runIf(existsSync(COMMITTED))("the artifact compiled from the real recorded run", () => {
  const capability = parseCapability(JSON.parse(readFileSync(COMMITTED, "utf8")));

  it("is valid against the schema", () => {
    expect(capability.schemaVersion).toBe(1);
    expect(capability.steps.length).toBeGreaterThan(0);
  });

  it("contains no credential or recorded member data", () => {
    const serialised = JSON.stringify(capability);
    expect(serialised).not.toContain("demo");
    expect(serialised).not.toContain("12345");
    for (const input of capability.inputs) {
      if (input.sensitivity !== "none") expect(input.example).toBeUndefined();
    }
  });

  it("reads the balance by grid coordinate, its only unambiguous handle", () => {
    const read = capability.steps.find((s) => s.action === "read");
    expect(read?.target?.strategies[0]?.strategy.kind).toBe("grid_cell");
  });
});
