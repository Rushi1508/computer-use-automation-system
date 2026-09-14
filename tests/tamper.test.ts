/**
 * Tampering with an artifact must not turn an irreversible operation into an
 * unattended one.
 *
 * Driven against the real demo application with a real browser, and judged by
 * the application's own state — whether a sub-account was actually opened —
 * not only by what the replay result says.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accountsOf, findMember } from "../apps/legacy-demo/data.js";
import { createApp } from "../apps/legacy-demo/server.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import { launchWebSurface } from "../src/perception/web-playwright.js";
import { denyByDefault } from "../src/policy/confirm.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { replay, type ReplayResult } from "../src/replay/engine.js";
import { approvalRecordFor, APPROVALS_DIR } from "../src/schema/approval.js";
import { type Capability, parseCapability } from "../src/schema/capability.js";
import { readCapabilityFile } from "../src/schema/load.js";

const SCRATCH = join(".runs", "__test_tamper__");
const SOURCE = join("capabilities", "open_sub_account.v2.json");
const IRREVERSIBLE_STEP = 8;
const INPUTS = { operatorId: "op-test", password: "demo", memberId: "12345", accountType: "Savings", initialDeposit: "500.00" };

let server: Server;
let base: string;
const roots: string[] = [];
let seq = 0;

beforeAll(async () => {
  await new Promise<void>((ready) => {
    server = createApp().listen(0, "127.0.0.1", () => ready());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Artifact = Record<string, unknown> & { approvalState: string; steps: { risk: string }[] };
const artifact = (): Artifact => JSON.parse(readFileSync(SOURCE, "utf8")) as Artifact;

/**
 * Writes an artifact, plus an approval record for `approvedContent` when given,
 * and loads it the way every command does.
 */
function load(content: object, approvedContent?: object): Capability {
  const root = mkdtempSync(join(tmpdir(), "cua-tamper-"));
  roots.push(root);
  const file = join(root, "open_sub_account.v2.json");
  writeFileSync(file, JSON.stringify(content, null, 2), "utf8");
  if (approvedContent !== undefined) {
    mkdirSync(join(root, APPROVALS_DIR));
    const record = approvalRecordFor(parseCapability(approvedContent), "reviewer-test", "");
    writeFileSync(join(root, APPROVALS_DIR, "open_sub_account.v2.json"), JSON.stringify(record), "utf8");
  }
  const loaded = readCapabilityFile(file);
  if (!loaded.ok) throw new Error(`fixture did not load: ${loaded.problem}`);
  return loaded.capability;
}

const accountsOf12345 = (): number => {
  const member = findMember("12345");
  if (member === undefined) throw new Error("fixture member missing");
  return accountsOf(member).length;
};

/** Replays with nobody to ask: no escalation handler, and every confirmation refused. */
async function unattended(capability: Capability): Promise<{ result: ReplayResult; opened: number }> {
  await fetch(`${base}/_control/reset`, { method: "POST" });
  const before = accountsOf12345();
  const surface = await launchWebSurface({ settleMs: 150 });
  try {
    const result = await replay({
      capability,
      inputs: INPUTS,
      surface,
      policy: new PolicyEngine(defaultPolicyConfig(base)),
      evidence: new EvidenceBus(`${newRunId("test-tamper")}-${++seq}`, SCRATCH),
      entrypoint: `${base}/`,
      onConfirm: denyByDefault,
      stepTimeoutMs: 5000,
      pollMs: 150,
    });
    return { result, opened: accountsOf12345() - before };
  } finally {
    await surface.close();
  }
}

function expectHeldAtIrreversibleStep(result: ReplayResult): void {
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.failure.kind).toBe("confirmation_refused");
  expect(result.failure.stepIndex).toBe(IRREVERSIBLE_STEP);
}

describe("tampering with an artifact cannot make an irreversible step run unattended", () => {
  it("baseline: an untampered draft stops at its irreversible step", async () => {
    const { result, opened } = await unattended(load(artifact()));
    expectHeldAtIrreversibleStep(result);
    expect(opened).toBe(0);
  }, 60_000);

  it("a step whose risk was edited down to safe_reversible still stops, and the failure says why", async () => {
    const tampered = artifact();
    tampered.steps[IRREVERSIBLE_STEP]!.risk = "safe_reversible";
    const { result, opened } = await unattended(load(tampered));
    expectHeldAtIrreversibleStep(result);
    expect(result.status === "failed" && result.failure.expected).toContain("declares this step reversible");
    expect(opened).toBe(0);
  }, 60_000);

  it("an artifact that declares itself approved is still a draft", async () => {
    const tampered = artifact();
    tampered.approvalState = "approved";
    const capability = load(tampered);
    expect(capability.approvalState).toBe("draft");
    const { result, opened } = await unattended(capability);
    expectHeldAtIrreversibleStep(result);
    expect(opened).toBe(0);
  }, 60_000);

  it("an approved artifact edited after approval loses the approval", async () => {
    const tampered = artifact();
    tampered.steps[IRREVERSIBLE_STEP]!.risk = "safe_reversible";
    const capability = load(tampered, artifact());
    expect(capability.approvalState).toBe("draft");
    const { result, opened } = await unattended(capability);
    expectHeldAtIrreversibleStep(result);
    expect(opened).toBe(0);
  }, 60_000);

  it("a genuine approval still lets the reviewed irreversible step run unattended", async () => {
    const content = artifact();
    const capability = load(content, content);
    expect(capability.approvalState).toBe("approved");
    const { result, opened } = await unattended(capability);
    expect(result.status).toBe("succeeded");
    expect(opened).toBe(1);
  }, 60_000);
});
