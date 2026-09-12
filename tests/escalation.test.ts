import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";

import { runDiscovery } from "../src/agent/loop.js";
import { DeskError, HandoffDesk } from "../src/escalation/desk.js";
import type { EscalationRequest } from "../src/escalation/types.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import type { Action, Observation, ObservedElement, Surface } from "../src/perception/types.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { LeasedSurface, LeaseViolation, SessionLease } from "../src/session/lease.js";

const SCRATCH = join(".runs", "__test_escalation__");
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const ORIGIN = "http://127.0.0.1:4173";

function control(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    nodeId: 0,
    actionable: true,
    role: "textbox",
    name: "Operator ID",
    value: "",
    enabled: true,
    visible: true,
    framePath: [],
    anchorText: null,
    hints: { tag: "input", inputType: "text", domId: null, fieldName: "operator" },
    ...overrides,
  };
}

const SCREEN_ELEMENTS: ObservedElement[] = [
  control({ nodeId: 0 }),
  control({ nodeId: 1, name: "Password", hints: { tag: "input", inputType: "password", domId: null, fieldName: "password" } }),
  control({ nodeId: 2, role: "button", name: "Sign On", value: null, hints: { tag: "input", inputType: "submit", domId: null, fieldName: null } }),
];

function stubSurface(elements: ObservedElement[] = SCREEN_ELEMENTS): Surface & { readonly acts: Action[] } {
  const acts: Action[] = [];
  const observation: Observation = {
    url: `${ORIGIN}/`,
    title: "Sign On",
    framePaths: [[]],
    elements,
    tree: '# frame: (top)\n- textbox "Operator ID"\n- button "Sign On"',
    capturedAt: "",
    warnings: [],
  };
  return {
    acts,
    observe: async () => observation,
    act: async (action) => {
      acts.push(action);
      return { ok: true };
    },
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    close: async () => {},
  };
}

function request(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    mode: "replay",
    runId: "test-run",
    capabilityId: "test_capability",
    goal: "test goal",
    stepIndex: 3,
    stepIntent: "Search for the member",
    reason: { kind: "replay_failure", code: "target_not_found", detail: "Search button missing" },
    expected: "the button Search",
    observed: "a different screen",
    allowed: ["resume", "completed_manually", "abort"],
    ...overrides,
  };
}

const waitUntil = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// --- The lease ---------------------------------------------------------------------

describe("session lease", () => {
  it("starts with automation in control", () => {
    const lease = new SessionLease();
    expect(lease.state).toBe("automation");
    expect(lease.isHeldBy(lease.automation)).toBe(true);
  });

  it("walks the full handoff cycle, with nobody in control while paused", () => {
    const lease = new SessionLease();
    lease.requestHuman("stuck");
    expect(lease.state).toBe("pending_human");
    expect(lease.holder).toBeNull();

    lease.claim("alice", "claimed");
    expect(lease.holder).toEqual({ kind: "operator", id: "alice" });
    expect(lease.generation).toBe(1);

    lease.release("alice", "done");
    expect(lease.state).toBe("resuming");
    expect(lease.holder).toBeNull();

    lease.resumeAutomation("back");
    expect(lease.state).toBe("automation");
    expect(lease.generation).toBe(2);
    expect(lease.transitions.map((t) => t.to)).toEqual(["pending_human", "human", "resuming", "automation"]);
  });

  it("rejects transitions out of order, and a release by anyone but the holder", () => {
    const lease = new SessionLease();
    expect(() => lease.claim("alice", "x")).toThrow(LeaseViolation);
    lease.requestHuman("stuck");
    expect(() => lease.resumeAutomation("x")).toThrow(LeaseViolation);
    lease.claim("alice", "claimed");
    expect(() => lease.release("bob", "x")).toThrow(/does not hold/);
  });

  it("can withdraw an unclaimed request and revoke an abandoned claim", () => {
    const unclaimed = new SessionLease();
    unclaimed.requestHuman("x");
    unclaimed.withdraw("timed out");
    unclaimed.resumeAutomation("back");
    expect(unclaimed.state).toBe("automation");

    const abandoned = new SessionLease();
    abandoned.requestHuman("x");
    abandoned.claim("alice", "claimed");
    abandoned.revoke("timed out");
    abandoned.resumeAutomation("back");
    expect(abandoned.state).toBe("automation");
  });
});

describe("leased surface", () => {
  it("lets only the current holder observe or act, and lets anyone look", async () => {
    const inner = stubSurface();
    const lease = new SessionLease();
    const automation = new LeasedSurface(inner, lease, lease.automation);
    const operator = new LeasedSurface(inner, lease, { kind: "operator", id: "alice" });

    await automation.act({ kind: "wait", ms: 1 });
    await expect(operator.act({ kind: "wait", ms: 1 })).rejects.toThrow(LeaseViolation);

    lease.requestHuman("stuck");
    // Paused: nobody may act, including automation.
    await expect(automation.observe()).rejects.toThrow(LeaseViolation);
    await expect(operator.observe()).rejects.toThrow(LeaseViolation);

    lease.claim("alice", "claimed");
    await operator.act({ kind: "wait", ms: 1 });
    await expect(automation.act({ kind: "wait", ms: 1 })).rejects.toThrow(/does not control/);

    // Screenshots never change the session.
    await expect(automation.screenshot()).resolves.toBeInstanceOf(Buffer);
    expect(inner.acts).toHaveLength(2);
  });
});

// --- The desk ------------------------------------------------------------------------

function desk(options: { timeoutMs?: number } = {}): { desk: HandoffDesk; lease: SessionLease; evidence: EvidenceBus; surface: ReturnType<typeof stubSurface> } {
  const surface = stubSurface();
  const lease = new SessionLease();
  const evidence = new EvidenceBus(newRunId("desk"), SCRATCH);
  return {
    desk: new HandoffDesk({ surface, lease, policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)), evidence, ...options }),
    lease,
    evidence,
    surface,
  };
}

describe("handoff desk", () => {
  it("pauses automation, records what the operator did, and hands control back", async () => {
    const { desk: d, lease, evidence, surface } = desk();
    const pending = d.escalate(request());

    await waitUntil(() => d.list().some((i) => i.status === "open"));
    const id = d.list()[0]!.id;
    expect(lease.state).toBe("pending_human");
    expect(d.get(id).stepIndex).toBe(3);
    expect(d.get(id).screenshots.length).toBeGreaterThan(0);

    d.claim(id, "alice");
    await d.observe(id, "alice");
    await d.act(id, "alice", { kind: "fill", nodeId: 1, value: "Sup3rSecret-typed" });
    await d.act(id, "alice", { kind: "click", nodeId: 2 });
    await d.resolve(id, "alice", { kind: "resume" }, "Signed back in by hand.");

    const outcome = await pending;
    expect(outcome.resolution.kind).toBe("resume");
    expect(outcome.operator).toBe("alice");
    expect(outcome.actions.map((a) => a.action.kind)).toEqual(["fill", "click"]);
    expect(outcome.actions[1]?.target?.name).toBe("Sign On");
    expect(lease.state).toBe("automation");
    expect(surface.acts).toHaveLength(2);

    // The persisted record carries the lease history and never the secret the operator typed.
    const file = join(evidence.dir, "interventions", readdirSync(join(evidence.dir, "interventions"))[0]!);
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain("Sup3rSecret-typed");
    const record = JSON.parse(persisted) as { lease: { to: string }[]; status: string; note: string };
    expect(record.status).toBe("resolved");
    expect(record.lease.map((t) => t.to)).toEqual(["pending_human", "human", "resuming", "automation"]);
  });

  it("offers only resolutions that fit the reason", async () => {
    const { desk: d } = desk();
    const pending = d.escalate(request());
    await waitUntil(() => d.list().length > 0);
    const id = d.list()[0]!.id;
    d.claim(id, "alice");
    await expect(d.resolve(id, "alice", { kind: "approve" }, "")).rejects.toMatchObject({ status: 400 });
    await d.resolve(id, "alice", { kind: "abort" }, "");
    await pending;
  });

  it("refuses actions from anyone but the claimant, and before the screen has been looked at", async () => {
    const { desk: d } = desk();
    const pending = d.escalate(request());
    await waitUntil(() => d.list().length > 0);
    const id = d.list()[0]!.id;

    await expect(d.observe(id, "alice")).rejects.toMatchObject({ status: 409 });
    d.claim(id, "alice");
    expect(() => d.claim(id, "bob")).toThrow(DeskError);
    await expect(d.observe(id, "bob")).rejects.toMatchObject({ status: 403 });
    await expect(d.act(id, "alice", { kind: "click", nodeId: 2 })).rejects.toMatchObject({ status: 409 });

    await d.resolve(id, "alice", { kind: "abort" }, "");
    await pending;
  });

  it("holds the operator to the allowlist", async () => {
    const { desk: d } = desk();
    const pending = d.escalate(request());
    await waitUntil(() => d.list().length > 0);
    const id = d.list()[0]!.id;
    d.claim(id, "alice");
    await d.observe(id, "alice");
    await expect(d.act(id, "alice", { kind: "navigate", url: "https://example.com/" })).rejects.toMatchObject({ status: 403 });
    await d.resolve(id, "alice", { kind: "abort" }, "");
    await pending;
  });

  it("aborts an intervention nobody resolves in time and returns control to automation", async () => {
    const { desk: d, lease } = desk({ timeoutMs: 50 });
    const outcome = await d.escalate(request());
    expect(outcome.resolution.kind).toBe("abort");
    expect(outcome.note).toContain("Timed out");
    expect(lease.state).toBe("automation");
  });
});

// --- Discovery handoff, with a scripted model ---------------------------------------------

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

/** Plays the operator: waits for an intervention, claims it, resolves it. */
async function operatorResolves(d: HandoffDesk, note: string): Promise<void> {
  await waitUntil(() => d.list().some((i) => i.status === "open"));
  const id = d.list().find((i) => i.status === "open")!.id;
  d.claim(id, "alice");
  await d.resolve(id, "alice", { kind: "resume" }, note);
}

describe("discovery hands the live session to a person", () => {
  it("when the agent asks for help, and tells the agent what the person did", async () => {
    const { desk: d, lease, evidence } = desk();
    const { client, requests } = scriptedClient([
      toolUse("t1", "escalate", { reason: "The search form is not where I expected it." }),
      toolUse("t2", "done", { summary: "Operator restored the form." }),
    ]);

    const [result] = await Promise.all([
      runDiscovery({
        goal: "look up a member",
        entrypoint: `${ORIGIN}/`,
        surface: new LeasedSurface(stubSurface(), lease, lease.automation),
        policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)),
        evidence,
        client,
        escalation: d.escalate,
        maxCostUsd: 1,
      }),
      operatorResolves(d, "Reopened the search form for the agent."),
    ]);

    expect(result.status).toBe("succeeded");
    expect(result.interventions?.[0]).toMatchObject({ reasonKind: "agent_escalated", resolution: "resume", operator: "alice" });
    // The second model call carries the operator's handback briefing.
    expect(JSON.stringify(requests[1])).toContain("Reopened the search form for the agent.");
  });

  it("when the agent is stuck, before it spends more turns failing", async () => {
    const { desk: d, lease, evidence } = desk();
    const wrongClick = (id: string): ScriptedResponse => toolUse(id, "click", { nodeId: 999, why: "try the button" });
    const { client, requests } = scriptedClient([
      wrongClick("t1"),
      wrongClick("t2"),
      wrongClick("t3"),
      toolUse("t4", "done", { summary: "Recovered after help." }),
    ]);

    const [result] = await Promise.all([
      runDiscovery({
        goal: "sign on",
        entrypoint: `${ORIGIN}/`,
        surface: new LeasedSurface(stubSurface(), lease, lease.automation),
        policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)),
        evidence,
        client,
        escalation: d.escalate,
        stuckThreshold: 3,
        maxCostUsd: 1,
      }),
      operatorResolves(d, "The node ids were stale; refreshed the screen."),
    ]);

    expect(result.status).toBe("succeeded");
    expect(result.interventions?.[0]?.reasonKind).toBe("agent_stuck");
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3])).toContain("refreshed the screen");
  });

  it("ends the run as escalated when no person is available", async () => {
    const { lease, evidence } = desk();
    const { client } = scriptedClient([toolUse("t1", "escalate", { reason: "Need a person." })]);
    const result = await runDiscovery({
      goal: "anything",
      entrypoint: `${ORIGIN}/`,
      surface: new LeasedSurface(stubSurface(), lease, lease.automation),
      policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)),
      evidence,
      client,
      maxCostUsd: 1,
    });
    expect(result.status).toBe("escalated");
  });
});
