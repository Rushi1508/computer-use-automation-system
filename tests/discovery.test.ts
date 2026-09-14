/**
 * Two guarantees the discovery loop makes about what it records, checked with a
 * scripted model so they hold on every run of the suite rather than only when
 * someone spends money on a live one.
 *
 * - A credential never reaches a persisted file, whether it was declared up
 *   front, is shaped like a known secret, or was only recognised once the agent
 *   typed it into a password field.
 * - A run is recorded as succeeded only when the success condition the artifact
 *   will carry actually holds on the live screen, not because the model said so.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";

import { type DiscoveryOptions, runDiscovery } from "../src/agent/loop.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import type { ActResult, Observation, ObservedElement, Surface } from "../src/perception/types.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";

const SCRATCH = join(".runs", "__test_discovery__");
const ORIGIN = "http://127.0.0.1:4173";
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

// --- Screens -------------------------------------------------------------------------

function control(nodeId: number, role: string, name: string, inputType: string | null, fieldName: string | null): ObservedElement {
  return {
    nodeId,
    actionable: true,
    role,
    name,
    value: role === "textbox" ? "" : null,
    enabled: true,
    visible: true,
    framePath: [],
    anchorText: null,
    hints: { tag: "input", inputType, domId: null, fieldName },
  };
}

const BALANCE: ObservedElement = {
  nodeId: 3,
  actionable: false,
  role: "text",
  name: "$14,820.37",
  value: "$14,820.37",
  enabled: true,
  visible: true,
  framePath: ["main"],
  anchorText: "Savings",
  grid: { columnHeader: "Balance", rowTexts: ["Savings"] },
  hints: { tag: "td", inputType: null, domId: null, fieldName: null },
};

function screen(elements: ObservedElement[], tree: string): Observation {
  return { url: `${ORIGIN}/`, title: "MERIDIAN CORE", framePaths: [[], ["main"]], elements, tree, capturedAt: "", warnings: [] };
}

/** Sign-on controls and a member's balance grid on one screen, so a short script can reach the goal. */
const MEMBER = screen(
  [
    control(0, "textbox", "Operator ID", "text", "operator"),
    control(1, "textbox", "Password", "password", "password"),
    control(2, "button", "Sign On", "submit", null),
    BALANCE,
    control(4, "link", "Member Search", null, null),
  ],
  '# frame: (top)\n- textbox "Operator ID"\n- textbox "Password"\n- button "Sign On"\n# frame: main\n- columnheader "Balance"\n- cell "$14,820.37"',
);

const SEARCH = screen(
  [control(4, "link", "Member Search", null, null), control(5, "textbox", "Member ID", "text", "memberId")],
  '# frame: main\n- textbox "Member ID"\n- button "Search"',
);

/** A surface whose screen changes when a given node is clicked. */
function stubSurface(first: Observation, onClick: Readonly<Record<number, Observation>> = {}): Surface {
  let current = first;
  return {
    observe: async () => current,
    act: async (action): Promise<ActResult> => {
      if (action.kind === "click") {
        const next = onClick[action.nodeId];
        if (next !== undefined) current = next;
      }
      return action.kind === "read" ? { ok: true, text: "$14,820.37" } : { ok: true };
    },
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
  };
}

// --- A scripted model ------------------------------------------------------------------

type ScriptedResponse = { content: unknown[]; stop_reason: string };

function scriptedClient(responses: ScriptedResponse[]): { client: Anthropic; requests: unknown[][] } {
  const requests: unknown[][] = [];
  const client = {
    messages: {
      create: async (params: { messages: unknown[] }) => {
        requests.push(JSON.parse(JSON.stringify(params.messages)) as unknown[]);
        const next = responses.shift();
        if (next === undefined) throw new Error("scripted model ran out of responses");
        return {
          ...next,
          stop_details: null,
          usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): ScriptedResponse => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id, name, input }],
});
const read = (id: string): ScriptedResponse =>
  toolUse(id, "read", { nodeId: 3, outputName: "savingsBalance", why: "the goal asks for the savings balance" });
const done = (id: string): ScriptedResponse => toolUse(id, "done", { summary: "Read the savings balance." });

let seq = 0;

async function discover(script: ScriptedResponse[], overrides: Partial<DiscoveryOptions> = {}) {
  const evidence = new EvidenceBus(`${newRunId("test-discovery")}-${++seq}`, SCRATCH);
  const { client, requests } = scriptedClient(script);
  const result = await runDiscovery({
    goal: "look up member 12345 and read their savings balance",
    entrypoint: `${ORIGIN}/`,
    surface: stubSurface(MEMBER),
    policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)),
    evidence,
    client,
    maxCostUsd: 1,
    ...overrides,
  });
  return { result, requests, evidence };
}

/** Every text file the run left on disk, concatenated. */
function persisted(evidence: EvidenceBus): string {
  return (readdirSync(evidence.dir, { recursive: true }) as string[])
    .filter((name) => /\.(jsonl?|txt)$/.test(name))
    .map((name) => readFileSync(join(evidence.dir, name), "utf8"))
    .join("\n");
}

const events = (evidence: EvidenceBus): string => readFileSync(join(evidence.dir, "events.jsonl"), "utf8");

// --- Credentials -------------------------------------------------------------------------
//
// Assertions are booleans on purpose: a failing `not.toContain` would print the
// file it searched, secret included, into the test output.

describe("a credential never reaches a persisted file", () => {
  it("when it is declared up front, even though the goal quotes it", async () => {
    const canary = ["declared", "canary", "4417"].join("-");
    const { result, evidence } = await discover([read("t1"), done("t2")], {
      goal: `Sign on with password '${canary}', then read the savings balance`,
      secrets: [canary],
    });

    expect(result.status).toBe("succeeded");
    expect(persisted(evidence).includes(canary)).toBe(false);
    // The first event is the one that used to leak: it records the goal before
    // the agent has typed anything.
    const first = JSON.parse(events(evidence).split("\n")[0] ?? "{}") as { kind?: string; data?: { goal?: string } };
    expect(first.kind).toBe("run.start");
    expect(first.data?.goal).toContain("[REDACTED]");
  });

  it("when it is shaped like an API key, a bearer token or an SSN, without being declared", async () => {
    const apiKey = `${["sk", "ant", "canary"].join("-")}${"0".repeat(24)}`;
    const bearer = `Bearer ${"canarytoken".padEnd(28, "1")}`;
    const ssn = ["123", "45", "6789"].join("-");
    const { evidence } = await discover([read("t1"), done("t2")], {
      goal: `Use key ${apiKey} with header ${bearer} for the member with SSN ${ssn}, then read the balance`,
    });

    const files = persisted(evidence);
    expect([apiKey, bearer, ssn].map((secret) => files.includes(secret))).toEqual([false, false, false]);
  });

  it("when nobody declared it, once the agent has typed it into a password field", async () => {
    const canary = ["undeclared", "canary", "9023"].join("-");
    const { result, evidence } = await discover(
      [toolUse("t1", "fill", { nodeId: 1, value: canary, why: "enter the password from the goal" }), read("t2"), done("t3")],
      { goal: `Sign on with password '${canary}', then read the savings balance` },
    );

    expect(result.status).toBe("succeeded");
    // run.start logged it in the clear, before the agent typed it. The event log
    // is rewritten at the end of the run, once it is known to be a secret.
    expect(persisted(evidence).includes(canary)).toBe(false);
  });
});

// --- Success ----------------------------------------------------------------------------

describe("a run is recorded as succeeded only when the proof is on screen", () => {
  it("rejects done when nothing has been verified, and stops as stuck instead of recording success", async () => {
    const { result, requests, evidence } = await discover([done("t1"), done("t2"), done("t3")], { stuckThreshold: 3 });

    expect(result.status).toBe("escalated");
    expect(JSON.stringify(requests[1])).toContain("Not accepted");
    expect(events(evidence)).toContain("Success claim not accepted");
  });

  it("accepts done once the value the goal asked for was read from a grid that is still on screen", async () => {
    const { result, evidence } = await discover([read("t1"), done("t2")]);

    expect(result.status).toBe("succeeded");
    expect(events(evidence)).toContain("Success verified");
  });

  it("accepts done after a checkpoint quoting visible text, when nothing was read", async () => {
    const { result } = await discover([
      toolUse("t1", "checkpoint", { description: 'The "Sign On" button is showing' }),
      done("t2"),
    ]);
    expect(result.status).toBe("succeeded");
  });

  it("rejects done when the proof it recorded is no longer on the screen", async () => {
    const { result, requests } = await discover(
      [read("t1"), toolUse("t2", "click", { nodeId: 4, why: "go back to the search screen" }), done("t3"), done("t4"), done("t5")],
      { surface: stubSurface(MEMBER, { 4: SEARCH }), stuckThreshold: 3 },
    );

    expect(result.status).toBe("escalated");
    expect(JSON.stringify(requests[3])).toContain("does not hold on the current screen");
  });
});
