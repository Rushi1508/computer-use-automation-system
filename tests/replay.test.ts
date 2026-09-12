import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../apps/legacy-demo/server.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import { resolveTarget, verifiableText } from "../src/locator/match.js";
import type { Observation, ObservedElement, Surface } from "../src/perception/types.js";
import { launchWebSurface } from "../src/perception/web-playwright.js";
import { autoApprove, type ConfirmHandler } from "../src/policy/confirm.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { replay, type ReplayResult, validateInputs } from "../src/replay/engine.js";
import { MERIDIAN_PROFILE } from "../src/schema/app-profile.js";
import { type Capability, CapabilitySchema, type RankedStrategy, type Step } from "../src/schema/capability.js";

// --- A hand-written capability ----------------------------------------------
//
// Deliberately not compiled from a recording: these tests exercise replay, so
// they must not depend on what a model happened to do in one discovery run. It
// also demonstrates that an artifact is something a person can author and read.

const ranked = (strategy: RankedStrategy["strategy"], confidence = 0.95): RankedStrategy => ({
  strategy,
  confidence,
  rationale: "test fixture",
});

const FIXTURE: Capability = CapabilitySchema.parse({
  schemaVersion: 1,
  id: "fixture_member_balance",
  version: 1,
  name: "Fixture member balance",
  description: "Signs on, looks up a member, reads the savings balance.",
  approvalState: "draft",
  surface: { kind: "legacy_web", entrypoint: "http://127.0.0.1:4173/", appProfileId: "meridian_core" },
  lineage: { overrides: [] },
  inputs: [
    { name: "operatorId", type: "string", required: true, description: "Operator", sensitivity: "pii" },
    { name: "password", type: "string", required: true, description: "Password", sensitivity: "secret" },
    { name: "memberId", type: "string", required: true, description: "Member", sensitivity: "pii" },
  ],
  outputs: [{ name: "savingsBalance", type: "string", description: "Balance", sensitivity: "none", fromStep: 5 }],
  steps: [
    {
      index: 0,
      intent: "Enter operator ID",
      action: "fill",
      target: { description: "Operator ID", framePath: [], actionable: true, strategies: [ranked({ kind: "role_name", role: "textbox", name: "Operator ID" })] },
      value: { param: "operatorId" },
      risk: "safe_reversible",
    },
    {
      index: 1,
      intent: "Enter password",
      action: "fill",
      target: { description: "Password", framePath: [], actionable: true, strategies: [ranked({ kind: "role_name", role: "textbox", name: "Password" })] },
      value: { param: "password" },
      risk: "safe_reversible",
    },
    {
      index: 2,
      intent: "Sign on",
      action: "click",
      target: { description: "Sign On", framePath: [], actionable: true, strategies: [ranked({ kind: "role_name", role: "button", name: "Sign On" })] },
      risk: "safe_reversible",
    },
    {
      index: 3,
      intent: "Enter member ID",
      action: "fill",
      target: { description: "Member ID", framePath: ["main"], actionable: true, strategies: [ranked({ kind: "role_name", role: "textbox", name: "Member ID" })] },
      value: { param: "memberId" },
      risk: "safe_reversible",
    },
    {
      index: 4,
      intent: "Search",
      action: "click",
      target: { description: "Search", framePath: ["main"], actionable: true, strategies: [ranked({ kind: "role_name", role: "button", name: "Search" })] },
      risk: "safe_reversible",
    },
    {
      index: 5,
      intent: "Read savings balance",
      action: "read",
      target: {
        description: "the Balance value in the Savings row",
        framePath: ["main"],
        actionable: false,
        strategies: [ranked({ kind: "grid_cell", column: "Balance", rowContains: "Savings" }, 0.92)],
      },
      outputName: "savingsBalance",
      risk: "safe_reversible",
    },
  ],
  authentication: { throughStep: 2 },
  successCheckpoint: { description: "The balance grid is showing", detector: { kind: "text_present", text: "Balance" } },
  knownOutcomes: MERIDIAN_PROFILE.knownOutcomes,
  provenance: { discoveryRunId: "fixture", goal: "fixture", model: "none", recordedAt: "2026-01-01T00:00:00Z", tracedSteps: 6 },
});

function withStep(capability: Capability, index: number, change: (step: Step) => Step): Capability {
  return CapabilitySchema.parse({
    ...capability,
    steps: capability.steps.map((step) => (step.index === index ? change(step) : step)),
  });
}

const HEALTHY = { operatorId: "op-test", password: "demo", memberId: "12345" };

// --- Harness -----------------------------------------------------------------

const SCRATCH = join(".runs", "__test_replay__");
let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((done) => {
    server = createApp().listen(0, "127.0.0.1", () => done());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(SCRATCH, { recursive: true, force: true });
});

interface RunOptions {
  readonly fault?: Record<string, string>;
  readonly onConfirm?: ConfirmHandler;
  readonly entrypoint?: string;
  readonly stepTimeoutMs?: number;
}

async function run(
  capability: Capability,
  inputs: Record<string, string>,
  options: RunOptions = {},
): Promise<ReplayResult> {
  await fetch(`${base}/_control/reset`, { method: "POST" });
  if (options.fault !== undefined) {
    await fetch(`${base}/_control/fault`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(options.fault),
    });
  }

  const surface = await launchWebSurface({ settleMs: 150 });
  try {
    return await replay({
      capability,
      inputs,
      surface,
      policy: new PolicyEngine(defaultPolicyConfig(base)),
      evidence: new EvidenceBus(newRunId("test-replay"), SCRATCH),
      entrypoint: options.entrypoint ?? `${base}/`,
      stepTimeoutMs: options.stepTimeoutMs ?? 5000,
      pollMs: 150,
      ...(options.onConfirm === undefined ? {} : { onConfirm: options.onConfirm }),
    });
  } finally {
    await surface.close();
  }
}

// --- Pure units ------------------------------------------------------------------

function cell(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    nodeId: 0,
    actionable: false,
    role: "text",
    name: "",
    value: "x",
    enabled: true,
    visible: true,
    framePath: ["main"],
    anchorText: "Savings",
    hints: { tag: "td", inputType: null, domId: null, fieldName: null },
    ...overrides,
  };
}

describe("the shared matcher", () => {
  const accountCell = cell({ nodeId: 1, value: "0002-8891", grid: { columnHeader: "Account", rowTexts: ["Savings", "$14,820.37"] } });
  const balanceCell = cell({ nodeId: 2, value: "$14,820.37", grid: { columnHeader: "Balance", rowTexts: ["0002-8891", "Savings"] } });

  it("skips an ambiguous strategy instead of guessing between matches", () => {
    // This is the exact shape of the bug the matcher exists to prevent: both
    // cells sit beside "Savings", so the row anchor alone matches two of them.
    const target = {
      description: "savings balance",
      framePath: ["main"],
      actionable: false,
      strategies: [
        ranked({ kind: "anchored_row", role: "text", anchorText: "Savings" }, 0.99),
        ranked({ kind: "grid_cell", column: "Balance", rowContains: "Savings" }, 0.9),
      ],
    };
    const resolution = resolveTarget(target, [accountCell, balanceCell]);
    expect(resolution.element?.nodeId).toBe(2);
    expect(resolution.winnerRank).toBe(1);
    expect(resolution.attempts[0]).toMatchObject({ outcome: "ambiguous", matches: 2 });
  });

  it("reports no match rather than falling back to anything nearby", () => {
    const target = {
      description: "missing",
      framePath: ["main"],
      actionable: false,
      strategies: [ranked({ kind: "grid_cell", column: "Balance", rowContains: "Checking" })],
    };
    const resolution = resolveTarget(target, [accountCell, balanceCell]);
    expect(resolution.element).toBeNull();
    expect(resolution.attempts[0]?.outcome).toBe("no_match");
  });

  it("respects frame and actionability", () => {
    const target = {
      description: "balance in another frame",
      framePath: ["navmenu"],
      actionable: false,
      strategies: [ranked({ kind: "grid_cell", column: "Balance", rowContains: "Savings" })],
    };
    expect(resolveTarget(target, [balanceCell]).element).toBeNull();
    expect(resolveTarget(target, [balanceCell], { anyFrame: true }).element?.nodeId).toBe(2);
  });
});

describe("checkpoint verification at record time", () => {
  const obs: Observation = {
    url: "http://app/",
    title: "MERIDIAN CORE",
    framePaths: [["main"]],
    elements: [cell({ grid: { columnHeader: "Balance", rowTexts: [] } })],
    tree: '# frame: main\n- heading "Member 12345"\n- columnheader "Balance"\n- cell "Dolores Abernathy"',
    capturedAt: "",
    warnings: [],
  };

  it("keeps a quoted structural label", () => {
    expect(verifiableText('The "Balance" column is showing', obs, [])).toBe("Balance");
  });

  it("rejects data values, identifiers and anything the run typed", () => {
    expect(verifiableText('Shows "Dolores Abernathy"', obs, [])).toBeNull();
    expect(verifiableText('Heading reads "Member 12345"', obs, [])).toBeNull();
    expect(verifiableText('The "Balance" column is showing', obs, ["Bal"])).toBeNull();
  });
});

describe("input contract", () => {
  it("names every missing and unknown input", () => {
    const problems = validateInputs(FIXTURE, { operatorId: "op", surprise: "x" });
    expect(problems).toContain("missing required input 'password'");
    expect(problems).toContain("missing required input 'memberId'");
    expect(problems).toContain("unknown input 'surprise'");
  });

  it("rejects a malformed invocation without touching the surface", async () => {
    const untouchable: Surface = {
      observe: () => Promise.reject(new Error("surface must not be used")),
      act: () => Promise.reject(new Error("surface must not be used")),
      screenshot: () => Promise.reject(new Error("surface must not be used")),
      close: () => Promise.resolve(),
    };
    const result = await replay({
      capability: FIXTURE,
      inputs: { operatorId: "op" },
      surface: untouchable,
      policy: new PolicyEngine(defaultPolicyConfig("http://127.0.0.1:4173")),
      evidence: new EvidenceBus(newRunId("test-replay"), SCRATCH),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("invalid_input");
    expect(result.failure.escalatable).toBe(false);
  });
});

// --- Against the live demo application --------------------------------------------

describe("replay against the live application", () => {
  it("succeeds and returns the declared output", async () => {
    const result = await run(FIXTURE, HEALTHY);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.outputs["savingsBalance"]).toBe("$14,820.37");
    expect(result.steps.find((s) => s.index === 5)?.resolvedBy?.kind).toBe("grid_cell");
    expect(result.drift).toHaveLength(0);
  }, 60_000);

  it("returns 'no such member' as a business outcome, not a failure", async () => {
    const result = await run(FIXTURE, { ...HEALTHY, memberId: "99999" });
    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.outcome.code).toBe("MEMBER_NOT_FOUND");
    expect(result.atStep).toBe(5);
  }, 60_000);

  it("distinguishes a permission denial from not-found", async () => {
    const result = await run(FIXTURE, { ...HEALTHY, memberId: "55555" });
    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.outcome.code).toBe("PERMISSION_DENIED");
  }, 60_000);

  it("dismisses a known interstitial and continues", async () => {
    const result = await run(FIXTURE, HEALTHY, { fault: { kind: "interstitial", pathPrefix: "/content" } });
    expect(result.status).toBe("succeeded");
    expect(result.recoveries.map((r) => r.id)).toContain("maintenance_interstitial");
  }, 60_000);

  it("re-authenticates on the same session after it expires, then resumes", async () => {
    const result = await run(FIXTURE, HEALTHY, { fault: { kind: "session_expired", pathPrefix: "/members/search" } });
    expect(result.status).toBe("succeeded");
    expect(result.recoveries.find((r) => r.id === "session_expired")?.remedy).toBe("reauthenticate");
    expect(result.steps.some((s) => s.reauthentication)).toBe(true);
  }, 60_000);

  it("absorbs a slow response with a bounded wait, and records it", async () => {
    const result = await run(FIXTURE, HEALTHY, {
      fault: { kind: "slow_load", pathPrefix: "/members/search", delayMs: "2500" },
      stepTimeoutMs: 8000,
    });
    expect(result.status).toBe("succeeded");
    expect(result.recoveries.map((r) => r.id)).toContain("transient_slow_render");
  }, 60_000);

  it("stops at once on the application's error page, with a screenshot", async () => {
    const result = await run(FIXTURE, HEALTHY, { fault: { kind: "server_error", pathPrefix: "/members/search" } });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("application_error");
    expect(result.failure.stepIndex).toBe(5);
    expect(result.failure.observed).toContain("Unexpected error");
    expect(result.failure.escalatable).toBe(true);
    expect(result.failure.evidence.screenshot).toBeDefined();
    expect(existsSync(result.failure.evidence.screenshot!)).toBe(true);
    // Stopped on detection, not by running out the step timeout.
    expect(result.elapsedMs).toBeLessThan(15_000);
  }, 60_000);

  it("reports drift when a fallback strategy carries a step", async () => {
    const drifted = withStep(FIXTURE, 5, (step) => ({
      ...step,
      target: {
        ...step.target!,
        strategies: [
          ranked({ kind: "anchored_row", role: "text", anchorText: "Renamed Label" }, 0.99),
          ...step.target!.strategies,
        ],
      },
    }));
    const result = await run(drifted, HEALTHY);
    expect(result.status).toBe("succeeded");
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({ stepIndex: 5, resolvedBy: "grid_cell", rank: 1 });
    expect(result.drift[0]?.bypassed[0]).toMatchObject({ kind: "anchored_row", outcome: "no_match" });
  }, 60_000);

  it("refuses an irreversible step in a draft capability unless a person approves it", async () => {
    const risky = withStep(FIXTURE, 4, (step) => ({ ...step, risk: "risky_irreversible" }));
    const result = await run(risky, HEALTHY);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("confirmation_refused");
    expect(result.failure.stepIndex).toBe(4);
    expect(result.failure.escalatable).toBe(true);
  }, 60_000);

  it("will not re-run a flow past an irreversible step to recover a session", async () => {
    const risky = withStep(FIXTURE, 4, (step) => ({ ...step, risk: "risky_irreversible" }));
    const result = await run(risky, HEALTHY, {
      onConfirm: autoApprove,
      fault: { kind: "session_expired", pathPrefix: "/members/search" },
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("unsafe_to_recover");
    expect(result.failure.escalatable).toBe(true);
  }, 60_000);

  it("refuses an entrypoint outside the allowlist", async () => {
    const result = await run(FIXTURE, HEALTHY, { entrypoint: "https://example.com/" });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.kind).toBe("policy_denied");
    expect(result.failure.escalatable).toBe(false);
  }, 60_000);
});
