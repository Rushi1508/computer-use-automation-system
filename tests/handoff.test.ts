/**
 * Handoff against the real stack: the demo application, a real browser session,
 * the operator console served over HTTP, and — in the first test — the console
 * page itself driven in a second browser, the way a person would use it.
 */

import { readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../apps/legacy-demo/server.js";
import { HandoffDesk } from "../src/escalation/desk.js";
import { OperatorClient } from "../src/escalation/operator-client.js";
import { createOperatorApp } from "../src/escalation/operator-server.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import { launchWebSurface } from "../src/perception/web-playwright.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { replay } from "../src/replay/engine.js";
import { parseCapability } from "../src/schema/capability.js";
import { LeasedSurface, LeaseViolation, SessionLease } from "../src/session/lease.js";

const SCRATCH = join(".runs", "__test_handoff__");
const OPEN_ACCOUNT = parseCapability(JSON.parse(readFileSync(join("capabilities", "open_sub_account.v2.json"), "utf8")));
const INPUTS = { operatorId: "op-test", password: "demo", memberId: "12345", accountType: "Savings", initialDeposit: "500.00" };

type Listening = { server: Server; base: string };

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<Listening> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

let target: Listening;

beforeAll(async () => {
  target = await listen(createApp());
});

afterAll(async () => {
  target.server.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

async function harness() {
  await fetch(`${target.base}/_control/reset`, { method: "POST" });
  const inner = await launchWebSurface({});
  const lease = new SessionLease();
  const policy = new PolicyEngine(defaultPolicyConfig(target.base));
  const evidence = new EvidenceBus(newRunId("handoff-test"), SCRATCH);
  const desk = new HandoffDesk({ surface: inner, lease, policy, evidence, timeoutMs: 45_000 });
  const operatorConsole = await listen(createOperatorApp(desk, lease));
  const automation = new LeasedSurface(inner, lease, lease.automation);

  const run = () =>
    replay({
      capability: OPEN_ACCOUNT,
      inputs: INPUTS,
      surface: automation,
      policy,
      evidence,
      entrypoint: `${target.base}/`,
      escalation: desk.escalate,
    });

  const close = async () => {
    await new Promise<void>((resolve) => operatorConsole.server.close(() => resolve()));
    await inner.close();
  };
  return { lease, automation, operatorConsole, run, close };
}

describe("human-in-the-loop handoff on a live session", () => {
  it("a person approves an irreversible step from the console page, and the same session completes", async () => {
    const h = await harness();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(h.operatorConsole.base);

      const person = (async () => {
        await page.getByRole("button", { name: /int-001/ }).click({ timeout: 30_000 });
        await page.getByRole("button", { name: "Claim and take control" }).click();
        // The page lists the controls of the live application screen: the form
        // automation filled in, not a fresh copy of it.
        await page.getByRole("heading", { name: /Controls on/ }).waitFor();
        await page.getByText("500.00", { exact: true }).waitFor();
        await page.getByPlaceholder("What you found and what you did").fill("Deposit and type look right.");
        await page.getByRole("button", { name: "approve", exact: true }).click();
      })();

      const [result] = await Promise.all([h.run(), person]);

      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") expect(result.outputs["newAccountNumber"]).toBe("0009-4000");
      expect(result.interventions).toEqual([
        expect.objectContaining({ reasonKind: "confirmation_required", stepIndex: 8, operator: "operator-1", resolution: "approve", note: "Deposit and type look right." }),
      ]);
      expect(h.lease.state).toBe("automation");
      expect(h.lease.transitions.map((t) => t.to)).toEqual(["pending_human", "human", "resuming", "automation"]);
    } finally {
      await browser.close();
      await h.close();
    }
  }, 90_000);

  it("while a person holds the session, automation and other operators are locked out", async () => {
    const h = await harness();
    const alice = new OperatorClient(h.operatorConsole.base, "alice");
    const bob = new OperatorClient(h.operatorConsole.base, "bob");
    try {
      const person = (async () => {
        const open = await alice.waitForOpen(30_000);
        await alice.claim(open.id);

        await expect(bob.claim(open.id)).rejects.toThrow(/^409/);
        await expect(bob.observe(open.id)).rejects.toThrow(/^403/);
        // Automation's own view of the session refuses to act while alice holds it.
        await expect(h.automation.act({ kind: "wait", ms: 1 })).rejects.toThrow(LeaseViolation);
        expect((await alice.lease()).holder).toEqual({ kind: "operator", id: "alice" });

        // A resolution that does not fit the reason is refused.
        await expect(alice.resolve(open.id, { kind: "resume" }, "")).rejects.toThrow(/^400/);
        await alice.observe(open.id);
        await alice.resolve(open.id, { kind: "reject" }, "Not today.");
      })();

      const [result] = await Promise.all([h.run(), person]);
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.failure.kind).toBe("confirmation_refused");
        expect(result.failure.escalatable).toBe(false);
        expect(result.failure.observed).toContain("refused by operator alice: Not today.");
      }
      // The irreversible step never ran: no account was opened.
      expect(result.steps.map((s) => s.index)).not.toContain(8);
    } finally {
      await h.close();
    }
  }, 90_000);
});
