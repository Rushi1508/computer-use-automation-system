/**
 * Regenerates the human-in-the-loop evidence under evidence/handoff/.
 *
 * Each scenario replays a capability with the handoff desk attached, so the run
 * pauses and raises an intervention when it needs a person. The "person" here
 * is a scripted operator, and that is stated plainly: it drives the live
 * session through the same HTTP API the operator console page uses, so every
 * claim, click and resolution goes through the session lease exactly as a
 * person's would. What is simulated is the human; the control transfer is not.
 *
 *   npm run handoff
 *
 * No model and no API key. Exits non-zero if any scenario does not end as expected.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";

import { createApp } from "../apps/legacy-demo/server.js";
import { HandoffDesk } from "../src/escalation/desk.js";
import { findControl, OperatorClient } from "../src/escalation/operator-client.js";
import { createOperatorApp } from "../src/escalation/operator-server.js";
import { EvidenceBus } from "../src/evidence/bus.js";
import { launchWebSurface } from "../src/perception/web-playwright.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { replay, type ReplayResult } from "../src/replay/engine.js";
import { formatReplayResult } from "../src/replay/format.js";
import { type Capability, parseCapability } from "../src/schema/capability.js";
import { LeasedSurface, SessionLease } from "../src/session/lease.js";

const ROOT = join("evidence", "handoff");

/** The demo application's published sign-on password, shown on its own login screen. */
const PASSWORD = process.env["MERIDIAN_PASSWORD"] ?? "demo";

const load = (file: string): Capability => parseCapability(JSON.parse(readFileSync(file, "utf8")));
const LOOKUP = load(join("capabilities", "lookup_member_savings_balance.v1.json"));
const OPEN_ACCOUNT = load(join("capabilities", "open_sub_account.v1.json"));

interface Scenario {
  readonly id: string;
  readonly condition: string;
  readonly capability: Capability;
  readonly inputs: Readonly<Record<string, string>>;
  readonly fault?: Readonly<Record<string, string>>;
  /** Returns a one-line account of what the operator did, for the summary. */
  readonly operator: (client: OperatorClient) => Promise<string>;
  readonly expectStatus: ReplayResult["status"];
  readonly expectDetail: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "01-operator-repairs-application-error",
    condition: "Application error on search; replay cannot recover by itself",
    capability: LOOKUP,
    inputs: { operatorId: "op-demo", password: PASSWORD, memberId: "12345" },
    fault: { kind: "server_error", pathPrefix: "/members/search" },
    operator: async (client) => {
      const intervention = await client.waitForOpen();
      await client.claim(intervention.id);

      // The person sees the error page, goes back to search in the same
      // session, and re-runs the lookup by hand. No sign-on: the session is live.
      let screen = await client.observe(intervention.id);
      await client.act(intervention.id, {
        kind: "click",
        nodeId: findControl(screen, { name: "Member Search", frame: "navmenu" }).nodeId,
      });
      screen = await client.observeUntil(intervention.id, (s) => s.controls.some((c) => c.name === "Member ID"));
      await client.act(intervention.id, {
        kind: "fill",
        nodeId: findControl(screen, { name: "Member ID", frame: "main" }).nodeId,
        value: "12345",
      });
      screen = await client.observe(intervention.id);
      await client.act(intervention.id, {
        kind: "click",
        nodeId: findControl(screen, { name: "Search", role: "button", frame: "main" }).nodeId,
      });
      await client.observeUntil(intervention.id, (s) => s.controls.some((c) => c.column === "Balance"));

      const note = "Search returned the application error page. Went back to Member Search and re-ran the lookup; member detail is showing.";
      await client.resolve(intervention.id, { kind: "resume" }, note);
      return `claimed ${intervention.id}, navigated back, re-ran the search (3 actions), resumed`;
    },
    expectStatus: "succeeded",
    expectDetail: "savingsBalance=$14,820.37",
  },
  {
    id: "02-operator-approves-irreversible-step",
    condition: "Draft capability reaches its irreversible step",
    capability: OPEN_ACCOUNT,
    inputs: { operatorId: "op-demo", password: PASSWORD, memberId: "12345", accountType: "Savings", initialDeposit: "500.00" },
    operator: async (client) => {
      const intervention = await client.waitForOpen();
      await client.claim(intervention.id);
      // A careful approver looks at the form before approving it.
      const screen = await client.observe(intervention.id);
      const deposit = findControl(screen, { anchorText: "Initial Deposit", role: "textbox" });
      const type = findControl(screen, { name: "Account Type" });
      const note = `Checked the form before approving: ${type.value ?? "?"} account, deposit ${deposit.value ?? "?"}.`;
      await client.resolve(intervention.id, { kind: "approve" }, note);
      return `claimed ${intervention.id}, inspected the filled form, approved`;
    },
    expectStatus: "succeeded",
    expectDetail: "newAccountNumber=0009-4000",
  },
  {
    id: "03-operator-rejects-irreversible-step",
    condition: "Draft capability reaches its irreversible step; the person declines",
    capability: OPEN_ACCOUNT,
    inputs: { operatorId: "op-demo", password: PASSWORD, memberId: "12345", accountType: "Certificate", initialDeposit: "25000.00" },
    operator: async (client) => {
      const intervention = await client.waitForOpen();
      await client.claim(intervention.id);
      await client.observe(intervention.id);
      await client.resolve(intervention.id, { kind: "reject" }, "Certificate opening above the unattended limit; needs branch manager sign-off.");
      return `claimed ${intervention.id}, rejected with a reason`;
    },
    expectStatus: "failed",
    expectDetail: "confirmation_refused",
  },
];

function detailOf(result: ReplayResult): string {
  switch (result.status) {
    case "succeeded":
      return Object.entries(result.outputs).map(([name, value]) => `${name}=${value}`).join(", ");
    case "business_outcome":
      return result.outcome.code;
    case "failed":
      return result.failure.kind;
  }
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind a port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function main(): Promise<number> {
  const target = await listen(createApp());
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const rows: string[] = [];
  let mismatches = 0;

  try {
    for (const scenario of SCENARIOS) {
      await fetch(`${target.base}/_control/reset`, { method: "POST" });
      if (scenario.fault !== undefined) {
        await fetch(`${target.base}/_control/fault`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(scenario.fault),
        });
      }

      const evidence = new EvidenceBus(scenario.id, ROOT);
      const policy = new PolicyEngine(defaultPolicyConfig(target.base));
      const inner = await launchWebSurface({});
      const lease = new SessionLease();
      const desk = new HandoffDesk({ surface: inner, lease, policy, evidence, timeoutMs: 120_000 });
      const console = await listen(createOperatorApp(desk, lease) as unknown as ReturnType<typeof createApp>);
      const client = new OperatorClient(console.base, "operator-sam");

      let result: ReplayResult;
      let didWhat: string;
      try {
        [result, didWhat] = await Promise.all([
          replay({
            capability: scenario.capability,
            inputs: scenario.inputs,
            surface: new LeasedSurface(inner, lease, lease.automation),
            policy,
            evidence,
            entrypoint: `${target.base}/`,
            escalation: desk.escalate,
          }),
          scenario.operator(client),
        ]);
      } finally {
        await new Promise<void>((resolve) => console.server.close(() => resolve()));
        await inner.close();
      }

      const detail = detailOf(result);
      const asExpected = result.status === scenario.expectStatus && detail === scenario.expectDetail;
      if (!asExpected) mismatches++;

      process.stdout.write(
        `\n=== ${scenario.id} — ${scenario.condition} — ${asExpected ? "as expected" : "UNEXPECTED"} ===\n` +
          `Operator: ${didWhat}\nLease after run: ${lease.state} (generation ${lease.generation}, ${lease.transitions.length} transitions)\n` +
          formatReplayResult(result),
      );

      const handoff = result.interventions[0];
      rows.push(
        `| [${scenario.id}](./${scenario.id}/interventions/${handoff?.id ?? "int-001"}.json) | ${scenario.condition} | ` +
          `${handoff === undefined ? "—" : `${handoff.reason} at step ${handoff.stepIndex ?? "-"}`} | ${didWhat} | ` +
          `${handoff?.resolution ?? "—"} | ${result.status}: ${detail} | ${asExpected ? "yes" : "**NO**"} |`,
      );
    }
  } finally {
    target.server.close();
  }

  writeFileSync(
    join(ROOT, "SUMMARY.md"),
    [
      "# Human-in-the-loop handoff scenarios",
      "",
      "Each run pauses on the live session and raises an intervention. A scripted operator claims it",
      "through the operator console's HTTP API — the same API a person's console page uses — acts on",
      "the same browser session, and hands it back. The human is simulated; the control transfer is not.",
      "",
      "Regenerate with `npm run handoff`. Each scenario directory holds the replay's events and result,",
      "the full intervention record (context, lease transitions, operator actions, state before and after),",
      "and screenshots of the session as it was handed over and handed back.",
      "",
      "`open_sub_account` is a hand-authored capability, labelled as such in its provenance, used so there is",
      "a genuinely irreversible step to decide on without spending model budget on a second recording.",
      "",
      "| Scenario | Condition | Why it paused | What the operator did | Resolution | Run ended | As expected |",
      "|---|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  );

  process.stdout.write(`\n${SCENARIOS.length - mismatches}/${SCENARIOS.length} handoff scenarios ended as expected.\n`);
  return mismatches === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
