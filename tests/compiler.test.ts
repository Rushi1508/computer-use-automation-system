import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DiscoveryResult, TraceStep } from "../src/agent/loop.js";
import { compile } from "../src/compiler/compile.js";
import { deriveStrategies, NoStrategyError } from "../src/compiler/strategies.js";
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

function step(overrides: Partial<TraceStep> = {}): TraceStep {
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
    at: new Date().toISOString(),
    ...overrides,
  };
}

function result(trace: TraceStep[], goal: string): DiscoveryResult {
  return {
    status: "succeeded",
    summary: "done",
    goal,
    entrypoint: "http://app/",
    trace,
    checkpoints: [],
    outputs: {},
    steps: trace.length,
    elapsedMs: 100,
    usage: { turns: 1, costUsd: 0, cacheWorking: true },
  };
}

describe("parameterisation — values never enter the artifact", () => {
  it("promotes a value named in the goal to a typed input", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    expect(capability.inputs.map((i) => i.name)).toEqual(["memberId"]);
    expect(capability.steps[0]?.value).toEqual({ param: "memberId" });
  });

  it("keeps a value the goal never mentions as a literal", () => {
    // A dropdown option chosen to satisfy the flow is part of the procedure,
    // not a caller argument.
    const s = step({
      action: { kind: "select", nodeId: 0, value: "Savings" },
      target: el({ role: "combobox", name: "Account Type" }),
    });
    const { capability } = compile(result([s], "open a sub-account for the member"), OPTS);
    expect(capability.inputs).toHaveLength(0);
    expect(capability.steps[0]?.value).toEqual({ literal: "Savings" });
  });

  it("always parameterises a password, however the goal was phrased", () => {
    const s = step({
      action: { kind: "fill", nodeId: 0, value: "hunter2" },
      target: el({
        name: "Password",
        hints: { tag: "input", inputType: "password", domId: null, fieldName: "password" },
      }),
    });
    const { capability } = compile(result([s], "sign on and do something"), OPTS);
    expect(capability.inputs[0]?.name).toBe("password");
    expect(capability.inputs[0]?.sensitivity).toBe("secret");
  });

  it("never writes the recorded literal anywhere in the artifact", () => {
    const s = step({
      action: { kind: "fill", nodeId: 0, value: "hunter2" },
      target: el({
        name: "Password",
        hints: { tag: "input", inputType: "password", domId: null, fieldName: "password" },
      }),
    });
    const { capability } = compile(result([s], "sign on with password hunter2"), OPTS);
    expect(JSON.stringify(capability)).not.toContain("hunter2");
  });

  it("stores an example only for non-sensitive inputs", () => {
    // An artifact is committed and read by reviewers, so an "illustrative" real
    // member number would be exactly the leak parameterisation prevents.
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
});

describe("locator strategies", () => {
  it("ranks role+name first when it is unique", () => {
    const target = el({ hints: { tag: "input", inputType: "text", domId: "ctl00_x", fieldName: "memberId" } });
    const ranked = deriveStrategies(target, [target]);
    expect(ranked[0]?.strategy.kind).toBe("role_name");
    expect(ranked[0]?.confidence).toBeGreaterThan(0.9);
    // Generated ids are recorded but ranked last.
    expect(ranked.at(-1)?.strategy.kind).toBe("dom_id");
  });

  it("demotes a strategy that would match more than one control", () => {
    const a = el({ nodeId: 0, name: "Search" });
    const b = el({ nodeId: 1, name: "Search" });
    const ranked = deriveStrategies(a, [a, b]);
    const roleName = ranked.find((r) => r.strategy.kind === "role_name");
    expect(roleName?.confidence).toBeLessThan(0.6);
    expect(roleName?.rationale).toContain("2 controls");
  });

  it("makes anchored targeting primary for a control with no accessible name", () => {
    // The load-bearing case: the demo target's unlabelled deposit field.
    const target = el({ name: "", anchorText: "Initial Deposit", hints: { tag: "input", inputType: "text", domId: null, fieldName: "deposit" } });
    const ranked = deriveStrategies(target, [target]);
    expect(ranked[0]?.strategy.kind).toBe("anchored_row");
    expect(ranked[0]?.rationale).toContain("no accessible name");
    expect(ranked.some((r) => r.strategy.kind === "role_name")).toBe(false);
  });

  it("refuses to emit a target it cannot identify", () => {
    const anonymous = el({ name: "", anchorText: null, hints: { tag: "input", inputType: "text", domId: null, fieldName: null } });
    expect(() => deriveStrategies(anonymous, [anonymous])).not.toThrow();
    expect(deriveStrategies(anonymous, [anonymous])).toHaveLength(0);
    // deriveTarget turns that into a loud failure rather than a broken artifact.
    expect(() => compile(result([step({ target: anonymous })], "goal"), OPTS)).toThrow(NoStrategyError);
  });
});

describe("contract and outcomes", () => {
  it("declares an output for each read step", () => {
    const s = step({
      action: { kind: "read", nodeId: 0 },
      outputName: "savingsBalance",
      target: el({ actionable: false, role: "text", name: "", anchorText: "Savings", value: "$14,820.37" }),
      extracted: "$14,820.37",
    });
    const { capability } = compile(result([s], "read the savings balance"), OPTS);
    expect(capability.outputs[0]?.name).toBe("savingsBalance");
    expect(capability.outputs[0]?.fromStep).toBe(0);
  });

  it("merges the application's outcome vocabulary from its profile", () => {
    // Discovery sees the happy path by construction, so outcomes are declared
    // against the application rather than learned per recording.
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    const codes = capability.knownOutcomes.map((o) => o.code);
    expect(codes).toContain("MEMBER_NOT_FOUND");
    expect(codes).toContain("PERMISSION_DENIED");
    expect(capability.knownOutcomes).toEqual(appProfile("meridian_core").knownOutcomes);
  });

  it("derives a success checkpoint that does not encode the argument", () => {
    // A final title of "Member 12345" would pass for one input and fail for
    // every other, so the label beside the value is used instead.
    const s = step({
      action: { kind: "read", nodeId: 0 },
      outputName: "savingsBalance",
      target: el({ actionable: false, role: "text", name: "", anchorText: "Savings" }),
      titleBefore: "Member 12345",
    });
    const { capability } = compile(result([s], "read savings for 12345"), OPTS);
    expect(JSON.stringify(capability.successCheckpoint)).not.toContain("12345");
    expect(capability.successCheckpoint.detector).toEqual({ kind: "text_present", text: "Savings" });
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

  it("refuses to compile a run that did not reach its goal", () => {
    const failed = { ...result([step()], "goal"), status: "escalated" as const };
    expect(() => compile(failed, OPTS)).toThrow(/Refusing to compile/);
  });

  it("starts every capability as a draft", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    expect(capability.approvalState).toBe("draft");
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
    const reparsed = parseCapability(JSON.parse(JSON.stringify(capability)));
    expect(reparsed).toEqual(capability);
  });

  it("rejects an artifact with a malformed identifier", () => {
    const { capability } = compile(result([step()], "look up member 12345"), OPTS);
    expect(() => CapabilitySchema.parse({ ...capability, id: "Not Snake Case" })).toThrow();
  });
});

describe("the artifact compiled from the real recorded run", () => {
  const capability = parseCapability(
    JSON.parse(readFileSync("capabilities/lookup_member_savings_balance.v1.json", "utf8")),
  );

  it("is valid against the schema", () => {
    expect(capability.schemaVersion).toBe(1);
    expect(capability.steps.length).toBeGreaterThan(0);
  });

  it("contains no credential material", () => {
    const serialised = JSON.stringify(capability);
    expect(serialised).not.toContain("demo");
    for (const input of capability.inputs) {
      if (input.sensitivity !== "none") expect(input.example).toBeUndefined();
    }
  });

  it("reaches the unnamed balance cell by anchor, its only durable handle", () => {
    const readStep = capability.steps.find((s) => s.action === "read");
    expect(readStep?.target?.strategies[0]?.strategy.kind).toBe("anchored_row");
  });
});
