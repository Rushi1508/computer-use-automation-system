import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { describeElement, renderObservation, toolDefinitions, TOOL_SCHEMAS } from "../src/agent/tools.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import type { Observation, ObservedElement } from "../src/perception/types.js";
import { redactor } from "../src/policy/redactor.js";

const SCRATCH = join(".runs", "__test__");
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function element(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    nodeId: 0,
    role: "textbox",
    name: "Member ID",
    value: null,
    enabled: true,
    visible: true,
    framePath: ["main"],
    anchorText: null,
    hints: { tag: "input", inputType: "text", domId: null, fieldName: "memberId" },
    ...overrides,
  };
}

describe("tool contract", () => {
  it("emits Messages-API-shaped schemas for every tool", () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(
      ["checkpoint", "click", "done", "escalate", "fill", "navigate", "read", "select"].sort(),
    );
    for (const def of defs) {
      expect(def.input_schema.type).toBe("object");
      expect(def.description.length).toBeGreaterThan(20);
    }
  });

  it("requires an intent on every acting tool", () => {
    // The intent string becomes the recorded step's rationale, which is what
    // makes an artifact reviewable rather than an opaque macro.
    for (const name of ["click", "fill", "select", "navigate", "read"] as const) {
      expect(TOOL_SCHEMAS[name].safeParse({ nodeId: 1, value: "x", url: "http://a", outputName: "o" }).success).toBe(
        false,
      );
    }
  });

  it("requires an output name on read, so extraction is declared not incidental", () => {
    expect(TOOL_SCHEMAS.read.safeParse({ nodeId: 1, why: "need balance" }).success).toBe(false);
    expect(
      TOOL_SCHEMAS.read.safeParse({ nodeId: 1, outputName: "savingsBalance", why: "need balance" }).success,
    ).toBe(true);
  });

  it("rejects a negative or fractional node id", () => {
    expect(TOOL_SCHEMAS.click.safeParse({ nodeId: -1, why: "x" }).success).toBe(false);
    expect(TOOL_SCHEMAS.click.safeParse({ nodeId: 1.5, why: "x" }).success).toBe(false);
  });
});

describe("observation rendering", () => {
  it("shows an unnamed control with its anchor so the model can still point at it", () => {
    const line = describeElement(element({ nodeId: 7, name: "", anchorText: "Initial Deposit" }));
    expect(line).toContain("[7]");
    expect(line).toContain("(unnamed)");
    expect(line).toContain('anchor="Initial Deposit"');
  });

  it("marks disabled controls", () => {
    expect(describeElement(element({ enabled: false }))).toContain("[disabled]");
  });

  it("renders controls, frames and the tree", () => {
    const obs: Observation = {
      url: "http://127.0.0.1:4173/content",
      title: "Member Search",
      framePaths: [["main"]],
      elements: [element({ nodeId: 0 }), element({ nodeId: 1, role: "button", name: "Search" })],
      tree: "- textbox 'Member ID'",
      capturedAt: new Date().toISOString(),
    };
    const rendered = renderObservation(obs);
    expect(rendered).toContain("URL: http://127.0.0.1:4173/content");
    expect(rendered).toContain("[0] textbox");
    expect(rendered).toContain("[1] button");
    expect(rendered).toContain("frame: main");
    expect(rendered).toContain("SCREEN (accessibility tree)");
  });

  it("truncates an oversized tree rather than flooding the context", () => {
    const obs: Observation = {
      url: "u",
      title: "t",
      framePaths: [],
      elements: [],
      tree: "x".repeat(10_000),
      capturedAt: new Date().toISOString(),
    };
    const rendered = renderObservation(obs);
    expect(rendered).toContain("(truncated)");
    expect(rendered.length).toBeLessThan(6000);
  });
});

describe("evidence bus", () => {
  it("writes append-only JSONL with monotonic sequence numbers", () => {
    const bus = new EvidenceBus(newRunId("t"), SCRATCH);
    bus.emit("run.start", "started");
    bus.emit("action.start", "click");
    bus.emit("run.end", "done");

    const lines = readFileSync(join(bus.dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2]);
  });

  it("redacts at the write boundary, not at the call site", () => {
    // The only way to write an unredacted byte should be to bypass the bus.
    redactor.registerSecret("swordfish-secret");
    const bus = new EvidenceBus(newRunId("t"), SCRATCH);
    bus.emit("action.start", "typed swordfish-secret into the form", {
      password: "swordfish-secret",
      memberId: "12345",
    });

    const written = readFileSync(join(bus.dir, "events.jsonl"), "utf8");
    expect(written).not.toContain("swordfish-secret");
    expect(written).toContain("[REDACTED]");
    // Business data survives.
    expect(written).toContain("12345");
  });

  it("persists a result document and screenshots", () => {
    const bus = new EvidenceBus(newRunId("t"), SCRATCH);
    bus.writeResult({ status: "succeeded", outputs: { savingsBalance: "$14,820.37" } });
    const file = join(bus.dir, "result.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).outputs.savingsBalance).toBe("$14,820.37");

    bus.saveScreenshot("final", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(existsSync(join(bus.dir, "screenshots", "final.png"))).toBe(true);
  });
});
