/**
 * Human-readable rendering of a replay result, for the CLI and the scenario
 * runner. The structured result is the contract; this is only a view of it.
 */

import type { ReplayResult } from "./engine.js";

export function formatReplayResult(result: ReplayResult): string {
  const lines: string[] = [
    `Status:     ${result.status}`,
    `Capability: ${result.capabilityId} v${result.capabilityVersion}`,
    `Entrypoint: ${result.entrypoint}`,
    `Elapsed:    ${(result.elapsedMs / 1000).toFixed(1)}s`,
  ];

  switch (result.status) {
    case "succeeded":
      lines.push("Outputs:");
      for (const [name, value] of Object.entries(result.outputs)) lines.push(`  ${name} = ${value}`);
      break;

    case "business_outcome":
      lines.push(
        `Outcome:    ${result.outcome.code} (at step ${result.atStep ?? "-"})`,
        `            ${result.outcome.description}`,
      );
      break;

    case "failed": {
      const f = result.failure;
      lines.push(
        `Failure:    ${f.kind}${f.escalatable ? " (escalatable to a person)" : ""}`,
        `  step:     ${f.stepIndex ?? "-"}${f.stepIntent !== null ? ` — ${f.stepIntent}` : ""}`,
        `  expected: ${f.expected}`,
        `  observed: ${f.observed}`,
      );
      if (f.evidence.screenshot !== undefined) lines.push(`  screenshot: ${f.evidence.screenshot}`);
      break;
    }
  }

  if (result.steps.length > 0) {
    lines.push("", "Steps:");
    for (const s of result.steps) {
      const via =
        s.resolvedBy === undefined
          ? ""
          : ` via ${s.resolvedBy.kind}${s.resolvedBy.rank > 0 ? ` (fallback, rank ${s.resolvedBy.rank})` : ""}`;
      const polls = s.polls > 0 ? `, ${s.polls} polls` : "";
      const reauth = s.reauthentication ? " [re-authentication]" : "";
      lines.push(`  ${String(s.index).padStart(2)}. ${s.action.padEnd(8)}${via}${polls}${reauth}`);
    }
  }

  if (result.recoveries.length > 0) {
    lines.push("", "Recoveries:");
    for (const r of result.recoveries) lines.push(`  - ${r.id} at step ${r.atStep ?? "-"}: ${r.detail}`);
  }

  if (result.drift.length > 0) {
    lines.push("", "Drift:");
    for (const d of result.drift) {
      const bypassed = d.bypassed.map((b) => `${b.kind} (${b.outcome.replace("_", " ")})`).join(", ");
      lines.push(`  - step ${d.stepIndex}: ${d.target} resolved by ${d.resolvedBy}; bypassed ${bypassed}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
