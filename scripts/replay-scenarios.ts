/**
 * Regenerates the replay evidence under evidence/replay/.
 *
 * Replays one capability against a fresh instance of the demo application under
 * each runtime condition the brief calls out — a healthy run, legitimate
 * business answers, recoverable interruptions, and hard failures — and writes
 * each run's structured log, result, and failure screenshot. No model is
 * involved and no API key is needed: this is the path a production agent
 * invokes.
 *
 *   npm run scenarios                      replays the current capability version
 *   npm run scenarios -- path/to/cap.json  replays another one
 *
 * Faults and data are set up out of band through the demo app's control plane,
 * so the artifact replayed in every scenario is byte-for-byte the committed one.
 * The script exits non-zero if any scenario does not end the way it should,
 * which makes it a regression check as well as an evidence generator.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";

import { createApp } from "../apps/legacy-demo/server.js";
import { EvidenceBus } from "../src/evidence/bus.js";
import { launchWebSurface } from "../src/perception/web-playwright.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { replay, type ReplayResult } from "../src/replay/engine.js";
import { formatReplayResult } from "../src/replay/format.js";
import { parseCapability } from "../src/schema/capability.js";

const ROOT = join("evidence", "replay");
const CAPABILITY_FILE = process.argv[2] ?? join("capabilities", "lookup_member_savings_balance.v3.json");

/**
 * The demo application's published sign-on password, shown on its own login
 * screen. Synthetic, not a credential — overridable so the same script can run
 * against an instance configured differently.
 */
const PASSWORD = process.env["MERIDIAN_PASSWORD"] ?? "demo";

const HEALTHY = { operatorId: "op-demo", password: PASSWORD, memberId: "12345" } as const;

interface Scenario {
  readonly id: string;
  readonly condition: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly fault?: Readonly<Record<string, string>>;
  /** An account opened out of band before the run. */
  readonly seedAccount?: Readonly<Record<string, string>>;
  readonly expectStatus: ReplayResult["status"];
  /** Output value, outcome code, or failure kind the run should end with. */
  readonly expectDetail: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "01-success",
    condition: "Healthy application, known member",
    inputs: HEALTHY,
    expectStatus: "succeeded",
    expectDetail: "savingsBalance=$14,820.37",
  },
  {
    id: "02-outcome-member-not-found",
    condition: "Member ID that does not exist",
    inputs: { ...HEALTHY, memberId: "99999" },
    expectStatus: "business_outcome",
    expectDetail: "MEMBER_NOT_FOUND",
  },
  {
    id: "03-outcome-permission-denied",
    condition: "Restricted member the operator may not view",
    inputs: { ...HEALTHY, memberId: "55555" },
    expectStatus: "business_outcome",
    expectDetail: "PERMISSION_DENIED",
  },
  {
    id: "04-outcome-malformed-member-id",
    condition: "Non-numeric member ID, rejected by the application",
    inputs: { ...HEALTHY, memberId: "abc" },
    expectStatus: "business_outcome",
    expectDetail: "MEMBER_ID_INVALID",
  },
  {
    id: "05-recovered-maintenance-interstitial",
    condition: "Unexpected maintenance notice before the search screen",
    inputs: HEALTHY,
    fault: { kind: "interstitial", pathPrefix: "/content" },
    expectStatus: "succeeded",
    expectDetail: "savingsBalance=$14,820.37",
  },
  {
    id: "06-recovered-session-expired",
    condition: "Session times out when the search is submitted",
    inputs: HEALTHY,
    fault: { kind: "session_expired", pathPrefix: "/members/search" },
    expectStatus: "succeeded",
    expectDetail: "savingsBalance=$14,820.37",
  },
  {
    id: "07-recovered-slow-load",
    condition: "Search response delayed by 3 seconds",
    inputs: HEALTHY,
    fault: { kind: "slow_load", pathPrefix: "/members/search", delayMs: "3000" },
    expectStatus: "succeeded",
    expectDetail: "savingsBalance=$14,820.37",
  },
  {
    id: "08-failed-application-error",
    condition: "Application returns its error page on search",
    inputs: HEALTHY,
    fault: { kind: "server_error", pathPrefix: "/members/search" },
    expectStatus: "failed",
    expectDetail: "application_error",
  },
  {
    id: "09-failed-invalid-invocation",
    condition: "Caller omits a required input",
    inputs: { operatorId: HEALTHY.operatorId, password: HEALTHY.password },
    expectStatus: "failed",
    expectDetail: "invalid_input",
  },
  {
    id: "10-outcome-no-savings-account",
    condition: "Member whose only account is checking",
    inputs: { ...HEALTHY, memberId: "23456" },
    expectStatus: "business_outcome",
    expectDetail: "NO_SAVINGS_ACCOUNT",
  },
  {
    id: "11-outcome-no-open-accounts",
    condition: "Closed member with no accounts at all",
    inputs: { ...HEALTHY, memberId: "67890" },
    expectStatus: "business_outcome",
    expectDetail: "NO_OPEN_ACCOUNTS",
  },
  {
    id: "12-failed-ambiguous-savings-accounts",
    condition: "Member with two savings accounts; the capability cannot tell which balance is meant",
    inputs: HEALTHY,
    seedAccount: { memberId: "12345", type: "Savings", depositCents: "50000" },
    expectStatus: "failed",
    expectDetail: "target_ambiguous",
  },
  {
    // Found by an edge-case sweep, not by the original recording: the run used
    // to walk past the sign-on screen looking for controls only a signed-on
    // session shows, and fail as an escalatable target_not_found — paging a
    // person over a wrong password, which no person at the desk can fix.
    id: "13-outcome-sign-on-failed",
    condition: "Credential the application rejects",
    inputs: { ...HEALTHY, password: "not-the-password" },
    expectStatus: "business_outcome",
    expectDetail: "SIGN_ON_FAILED",
  },
];

function detailOf(result: ReplayResult): string {
  switch (result.status) {
    case "succeeded":
      return Object.entries(result.outputs)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ");
    case "business_outcome":
      return result.outcome.code;
    case "failed":
      return result.failure.kind;
  }
}

async function control(base: string, path: string, body?: Readonly<Record<string, string>>): Promise<void> {
  const response = await fetch(`${base}/_control/${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }),
  });
  if (!response.ok) throw new Error(`control plane ${path} failed: ${response.status} ${await response.text()}`);
}

async function main(): Promise<number> {
  const capability = parseCapability(JSON.parse(readFileSync(CAPABILITY_FILE, "utf8")));

  const server = await new Promise<Server>((resolve) => {
    const listening = createApp().listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("demo app did not bind a port");
  const base = `http://127.0.0.1:${address.port}`;

  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const rows: string[] = [];
  let mismatches = 0;

  try {
    for (const scenario of SCENARIOS) {
      await control(base, "reset");
      if (scenario.fault !== undefined) await control(base, "fault", scenario.fault);
      if (scenario.seedAccount !== undefined) await control(base, "account", scenario.seedAccount);

      const evidence = new EvidenceBus(scenario.id, ROOT);
      const surface = await launchWebSurface({});
      let result: ReplayResult;
      try {
        result = await replay({
          capability,
          inputs: scenario.inputs,
          surface,
          policy: new PolicyEngine(defaultPolicyConfig(base)),
          evidence,
          // The recorded entrypoint names the environment discovery ran in;
          // this binds the same artifact to this instance.
          entrypoint: `${base}/`,
        });
      } finally {
        await surface.close();
      }

      const detail = detailOf(result);
      const asExpected = result.status === scenario.expectStatus && detail === scenario.expectDetail;
      if (!asExpected) mismatches++;

      process.stdout.write(
        `\n=== ${scenario.id} — ${scenario.condition} — ${asExpected ? "as expected" : "UNEXPECTED"} ===\n` +
          formatReplayResult(result),
      );

      const recoveries = result.recoveries.map((r) => `${r.id} (${r.remedy})`).join(", ") || "—";
      rows.push(
        `| [${scenario.id}](./${scenario.id}/result.json) | ${scenario.condition} | ${result.status} | ` +
          `${detail} | ${recoveries} | ${(result.elapsedMs / 1000).toFixed(1)}s | ${asExpected ? "yes" : "**NO**"} |`,
      );
    }
  } finally {
    server.close();
  }

  writeFileSync(
    join(ROOT, "SUMMARY.md"),
    [
      "# Replay scenarios",
      "",
      `Capability: \`${capability.id}\` v${capability.version}, replayed with no model in the loop.`,
      "Regenerate with `npm run scenarios`.",
      "",
      "| Scenario | Condition | Status | Result | Recoveries | Elapsed | As expected |",
      "|---|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  );

  process.stdout.write(`\n${SCENARIOS.length - mismatches}/${SCENARIOS.length} scenarios ended as expected.\n`);
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
