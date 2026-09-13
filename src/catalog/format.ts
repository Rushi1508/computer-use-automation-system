/**
 * Human-readable rendering of the catalog, for the CLI. The Catalog is the
 * contract; this is only a view of it.
 *
 * Written for two readers who want different things. Someone running `list` is
 * asking "what can this system do, and can I call it right now" — so a listing
 * leads with the contract and flags anything that would stop a call. Someone
 * running `describe` is reviewing one artifact before approving or invoking it —
 * so a description shows provenance, the step list with its risky steps marked,
 * what each version changed, and the exact command to run it.
 */

import { appProfile } from "../schema/app-profile.js";
import { invocationSchema, type Capability, type Detector } from "../schema/capability.js";
import {
  heldSteps,
  latestContractChange,
  type Catalog,
  type CatalogEntry,
  type VersionedCapability,
} from "./catalog.js";

const INDENT = "  ";

function describeInput(input: Capability["inputs"][number]): string {
  const marks = [
    input.required ? "required" : "optional",
    ...(input.sensitivity === "none" ? [] : [input.sensitivity]),
  ];
  return `${input.name}: ${input.type} (${marks.join(", ")})`;
}

function describeDetector(detector: Detector): string {
  switch (detector.kind) {
    case "text_present":
      return `the text "${detector.text}" is on screen`;
    case "text_absent":
      return `the text "${detector.text}" is gone`;
    case "text_matches":
      return `the screen text matches /${detector.pattern}/`;
    case "url_contains":
      return `the address contains "${detector.value}"`;
    case "title_equals":
      return `the page title is "${detector.value}"`;
    case "grid_column":
      return `a grid with a "${detector.column}" column has rendered a row`;
  }
}

function describeOutcome(outcome: Capability["knownOutcomes"][number]): string[] {
  const scope =
    "absentTarget" in outcome
      ? `recognised by the absence of step ${outcome.absentTarget.step}'s target, once ` +
        describeDetector(outcome.absentTarget.screenReady)
      : `recognised when ${describeDetector(outcome.detector)}` +
        (outcome.atSteps === undefined ? " at any step" : ` at step ${outcome.atSteps.join(", ")}`);
  return [`${outcome.code} — ${outcome.description}`, `${INDENT}${scope}`];
}

/** The command that invokes this capability, with secrets taken from the environment. */
export function exampleInvocation(capability: Capability): string {
  const args = capability.inputs.map((input) =>
    input.sensitivity === "secret"
      ? `--input-env ${input.name}=${input.name.toUpperCase()}`
      : `--input ${input.name}=<${input.type}>`,
  );
  return `npm run cua -- capabilities invoke ${capability.id} ${args.join(" ")}`.trim();
}

function summarizeVersion({ capability }: VersionedCapability): string {
  const held = heldSteps(capability);
  const risky = held.length === 0 ? "" : `, ${held.length} step(s) held for a person`;
  return `v${capability.version} (${capability.approvalState}${risky})`;
}

export function formatCatalogList(catalog: Catalog, dir: string): string {
  const lines: string[] = [];

  if (catalog.entries.length === 0) {
    lines.push(`No capabilities in ${dir}/.`);
  } else {
    lines.push(`${catalog.entries.length} capability(ies) in ${dir}/:`, "");
  }

  for (const entry of catalog.entries) {
    const capability = entry.latest.capability;
    lines.push(
      `  ${entry.id}  ${summarizeVersion(entry.latest)}`,
      `${INDENT.repeat(2)}${capability.description}`,
      `${INDENT.repeat(2)}inputs:   ${capability.inputs.map(describeInput).join(", ") || "(none)"}`,
      `${INDENT.repeat(2)}outputs:  ${capability.outputs.map((o) => `${o.name}: ${o.type}`).join(", ") || "(none)"}`,
      `${INDENT.repeat(2)}outcomes: ${capability.knownOutcomes.map((o) => o.code).join(", ") || "(none)"}`,
      `${INDENT.repeat(2)}surface:  ${capability.surface.kind} / ${capability.surface.appProfileId} at ${capability.surface.entrypoint}`,
      `${INDENT.repeat(2)}versions: ${entry.versions.map((v) => `v${v.capability.version}`).join(", ")}`,
    );

    if (capability.lineage.tenantId !== undefined) {
      lines.push(
        `${INDENT.repeat(2)}tenant:   ${capability.lineage.tenantId}` +
          (capability.lineage.baseCapabilityId === undefined
            ? ""
            : ` (derived from ${capability.lineage.baseCapabilityId})`),
      );
    }

    const change = latestContractChange(entry);
    if (change !== null && change.breaking) {
      lines.push(
        `${INDENT.repeat(2)}! v${change.to} changed the invocation contract; a caller written against ` +
          `v${change.from} may break. See describe.`,
      );
    }
    for (const blocker of entry.blockers) {
      lines.push(`${INDENT.repeat(2)}! not replayable: ${blocker}`);
    }
    lines.push("");
  }

  if (catalog.problems.length > 0) {
    // Surfaced rather than hidden: a file that failed to parse is a capability
    // somebody believes they have.
    lines.push(`${catalog.problems.length} file(s) could not be used:`);
    for (const problem of catalog.problems) {
      lines.push(`  ${problem.file}: ${problem.message.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatCapabilityDescription(entry: CatalogEntry, selected: VersionedCapability): string {
  const capability = selected.capability;
  const lines: string[] = [
    `${capability.id} v${capability.version} — ${capability.name}`,
    `  file:      ${selected.file}`,
    `  state:     ${capability.approvalState}`,
    `  surface:   ${capability.surface.kind} at ${capability.surface.entrypoint}`,
  ];

  let vendor = `${capability.surface.appProfileId} (unknown profile — this capability cannot be replayed)`;
  try {
    const profile = appProfile(capability.surface.appProfileId);
    vendor = `${profile.id} — ${profile.name}, ${profile.vendor} ${profile.productVersion}`;
  } catch {
    // Reported on the line above; the rest of the description is still useful.
  }
  lines.push(`  profile:   ${vendor}`, "", capability.description, "");

  lines.push("Inputs:");
  if (capability.inputs.length === 0) lines.push(`${INDENT}(none)`);
  for (const input of capability.inputs) {
    lines.push(`${INDENT}${describeInput(input)} — ${input.description}`);
  }

  lines.push("", "Outputs:");
  if (capability.outputs.length === 0) lines.push(`${INDENT}(none)`);
  for (const output of capability.outputs) {
    lines.push(
      `${INDENT}${output.name}: ${output.type} — ${output.description} (from step ${output.fromStep})`,
    );
  }

  lines.push("", "Business outcomes (exit code 2, not failures):");
  if (capability.knownOutcomes.length === 0) lines.push(`${INDENT}(none)`);
  for (const outcome of capability.knownOutcomes) {
    lines.push(...describeOutcome(outcome).map((line) => `${INDENT}${line}`));
  }

  lines.push("", "Steps:");
  for (const step of capability.steps) {
    const risky = step.risk === "risky_irreversible" ? " [irreversible]" : "";
    const auth =
      capability.authentication !== undefined && step.index <= capability.authentication.throughStep
        ? " [authentication]"
        : "";
    const target = step.target === undefined ? "" : ` ${step.target.description}`;
    const value =
      step.value === undefined ? "" : ` = ${"param" in step.value ? `{${step.value.param}}` : `"${step.value.literal}"`}`;
    lines.push(
      `${INDENT}${String(step.index).padStart(2)}. ${step.action.padEnd(8)}${target}${value}${risky}${auth}`,
      `${INDENT.repeat(3)}${step.intent}`,
    );
    if (step.checkpoint !== undefined) {
      lines.push(`${INDENT.repeat(3)}checkpoint: ${describeDetector(step.checkpoint.detector)}`);
    }
  }

  lines.push(
    "",
    `Success when: ${describeDetector(capability.successCheckpoint.detector)}`,
    `  (${capability.successCheckpoint.description})`,
  );

  lines.push(
    "",
    "Provenance:",
    `${INDENT}${capability.provenance.discoveryRunId} using ${capability.provenance.model}, recorded ${capability.provenance.recordedAt}`,
    `${INDENT}goal: ${capability.provenance.goal}`,
    `${INDENT}${capability.provenance.tracedSteps} traced step(s) compiled into ${capability.steps.length}`,
  );

  lines.push("", "Versions:");
  for (const version of entry.versions) {
    const here = version.capability.version === capability.version ? " <- shown" : "";
    lines.push(`${INDENT}${summarizeVersion(version)}${here}`);
    const revision = version.capability.provenance.revisions.at(-1);
    if (revision !== undefined && revision.version === version.capability.version) {
      lines.push(`${INDENT.repeat(2)}revised by ${revision.reviewer} on ${revision.revisedAt}`);
      for (const change of revision.changes) lines.push(`${INDENT.repeat(2)}- ${change}`);
    }
  }

  const change = latestContractChange(entry);
  if (change !== null) {
    const notes = [
      ...change.addedInputs.map((n) => `input ${n} added`),
      ...change.removedInputs.map((n) => `input ${n} removed`),
      ...change.newlyRequiredInputs.map((n) => `input ${n} is now required`),
      ...change.addedOutputs.map((n) => `output ${n} added`),
      ...change.removedOutputs.map((n) => `output ${n} removed`),
      ...change.addedOutcomes.map((n) => `outcome ${n} added`),
      ...change.removedOutcomes.map((n) => `outcome ${n} removed`),
    ];
    if (notes.length > 0) {
      lines.push(
        "",
        `Contract change v${change.from} -> v${change.to}` +
          (change.breaking ? " (BREAKING for existing callers):" : ":"),
        ...notes.map((note) => `${INDENT}${note}`),
      );
    }
  }

  lines.push(
    "",
    "Invocation schema (what a calling agent is given):",
    JSON.stringify(invocationSchema(capability), null, 2),
    "",
    "Invoke with:",
    `${INDENT}${exampleInvocation(capability)}`,
    "",
  );

  return lines.join("\n");
}
