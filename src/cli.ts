/**
 * Entry point for the computer-use automation system.
 *
 *   discover      LLM-driven run against a live surface; emits a capability artifact.
 *   replay        Deterministic execution of a saved artifact. No model in the loop.
 *   revise        Apply a reviewed revision to an artifact, producing its next version.
 *   capabilities  Browse the catalog and invoke a capability by id.
 *
 * discover and replay can run with --escalate, which serves the operator console
 * alongside the run so a person can take over the same live session when it
 * needs them.
 */

import "dotenv/config";

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";

import { z } from "zod";

import { runDiscovery } from "./agent/loop.js";
import { Catalog, CAPABILITY_DIR } from "./catalog/catalog.js";
import { formatCapabilityDescription, formatCatalogList } from "./catalog/format.js";
import { compile } from "./compiler/compile.js";
import { ReviewSchema, reviseCapability, RevisionError } from "./compiler/revise.js";
import { HandoffDesk } from "./escalation/desk.js";
import { createOperatorApp } from "./escalation/operator-server.js";
import type { EscalationHandler } from "./escalation/types.js";
import { EvidenceBus, newRunId } from "./evidence/bus.js";
import type { Surface } from "./perception/types.js";
import { launchWebSurface, type PlaywrightWebSurface } from "./perception/web-playwright.js";
import { autoApprove, denyByDefault } from "./policy/confirm.js";
import { PolicyEngine } from "./policy/engine.js";
import { redactor } from "./policy/redactor.js";
import { defaultPolicyConfig } from "./policy/types.js";
import { exitCodeFor, replay, validateInputs } from "./replay/engine.js";
import { formatReplayResult } from "./replay/format.js";
import { approvalRecordFor, approvalRecordPath } from "./schema/approval.js";
import type { Capability } from "./schema/capability.js";
import { describeSchemaError, readCapabilityFile, readJsonFile } from "./schema/load.js";
import { LeasedSurface, SessionLease } from "./session/lease.js";

type Command = "discover" | "replay" | "revise" | "capabilities";

const COMMANDS: Record<Command, string> = {
  discover: "Run the agent against a goal and record a capability artifact",
  replay: "Replay a saved capability artifact with typed input parameters",
  revise: "Apply a reviewed revision to a capability, writing its next version as a draft",
  capabilities: "Browse the capability catalog, or invoke a capability by id",
};

function usage(): string {
  const rows = Object.entries(COMMANDS)
    .map(([name, description]) => `  ${name.padEnd(14)}${description}`)
    .join("\n");
  return `Usage: npm run cua -- <command> [options]

Commands:
${rows}

discover options:
  --goal <text>             Natural-language goal (required)
  --url <url>               Entrypoint URL (required)
  --secret-env <VAR>        Declare a credential the goal uses, read from an environment
                            variable. Repeatable. Write {{VAR}} in --goal where it belongs:
                            the value is substituted for the model and registered for
                            redaction before anything is logged, so it never reaches the
                            evidence and never appears in shell history.
  --max-steps <n>           Step budget (default 30)
  --max-ms <n>              Wall-clock budget in ms (default 300000)
  --max-cost <usd>          Hard ceiling on estimated model spend (default 0.75)
  --effort <level>          low|medium|high|xhigh|max (default from ANTHROPIC_EFFORT)
  --capability <id>         snake_case id for the emitted artifact (enables compilation).
                            Refuses to overwrite an existing version.
  --app-profile <id>        Application profile supplying the outcome vocabulary
                            (default meridian_core)
  --headed                  Show the browser window
  --allow-risky             Auto-approve irreversible actions (supervised recording only).
                            Ignored with --escalate, where a person decides.

replay options:
  --capability <file>       Artifact to run (required)
  --input <name=value>      An input value. Repeatable.
  --input-env <name=VAR>    Read an input from an environment variable. Use this for
                            secrets, so they never appear in shell history or process lists.
  --entrypoint <url>        Bind the capability to another environment or tenant instance
  --headed                  Show the browser window
  --approve-risky           Approve irreversible steps (supervised use only).
                            Ignored with --escalate, where a person decides.

capabilities subcommands:
  list                      Everything in ${CAPABILITY_DIR}/, with its contract and version history.
                            Exits non-zero if any file there is not a usable artifact.
  describe <id>             One capability in full: steps, outcomes, provenance, invocation schema
  tools                     The JSON tool definitions an agent is given for the catalog
  invoke <id>               Replay a capability by id. Takes the same --input, --input-env,
                            --entrypoint, --headed and handoff options as replay.
  approve <id>              Record a reviewer's approval of one version, bound to a digest of
                            its content. Requires --reviewer <name>; takes --note <text>. An
                            approved capability runs its irreversible steps unattended; any
                            later edit to the artifact voids the approval.

capabilities options:
  --version <n>             Pin a version. Default: the highest version of that capability
  --dir <path>              Catalog directory (default ${CAPABILITY_DIR})

revise options:
  --capability <file>       The artifact to revise
  --review <file>           A reviewed revision naming the id and version it applies to.
                            Writes the next version as a draft. Existing versions are never
                            overwritten.

handoff options (discover and replay):
  --escalate                Serve the operator console and bring a person in when the run
                            is stuck, fails in a way a person could fix, or reaches an
                            irreversible step. The person works on the same live session.
  --operator-port <n>       Console port on 127.0.0.1 (default 4174)
  --intervention-timeout <ms>  Abort an intervention nobody resolves in time (default: wait)

  replay and capabilities invoke exit codes:
    0 succeeded, 2 business outcome (a legitimate answer), 1 failed.

  Set CUA_DEBUG=1 to print a stack trace for an unexpected error.
`;
}

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMANDS, value);
}

interface Args {
  readonly flags: ReadonlySet<string>;
  /** Last value given for each option. */
  readonly values: ReadonlyMap<string, string>;
  /** Every value given for each option, for repeatable options. */
  readonly multi: ReadonlyMap<string, readonly string[]>;
  /**
   * Bare words that were not consumed as an option's value: a subcommand and
   * the capability id it names. Collected wherever they appear, so
   * `describe --version 2 <id>` means what it looks like it means.
   */
  readonly positionals: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      multi.set(key, [...(multi.get(key) ?? []), next]);
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, values, multi, positionals };
}

/**
 * Reads a URL option, reporting a malformed one as an error a person can act
 * on. Without this the URL constructor's own TypeError reaches the top level
 * and is printed as a stack trace, which reads like a crash in the tool rather
 * than a typo in the command.
 */
function readUrl(raw: string, option: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    process.stderr.write(`${option} must be an absolute URL like http://host:port/, got '${raw}'\n`);
    return null;
  }
}

interface Handoff {
  readonly surface: Surface;
  readonly escalation: EscalationHandler;
  close(): Promise<void>;
}

/**
 * Serves the operator console for this run. The desk acts on the same browser
 * the run uses; automation gets a lease-checked view of it, so it cannot act
 * while a person holds the session.
 */
async function openOperatorConsole(
  inner: PlaywrightWebSurface,
  policy: PolicyEngine,
  evidence: EvidenceBus,
  args: Args,
): Promise<Handoff> {
  const lease = new SessionLease();
  const port = Number(args.values.get("operator-port") ?? process.env["OPERATOR_PORT"] ?? 4174);
  const timeout = args.values.get("intervention-timeout");
  const url = `http://127.0.0.1:${port}`;

  const desk = new HandoffDesk({
    surface: inner,
    lease,
    policy,
    evidence,
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
    onRaised: (intervention) => {
      process.stdout.write(
        `\n>>> ${intervention.id} needs a person: ${intervention.reason.code}` +
          `${intervention.stepIndex === null ? "" : ` at step ${intervention.stepIndex}`}.\n` +
          `    Open ${url} to take control of the live session. The run is paused until it is handed back.\n\n`,
      );
    },
  });

  const server = await new Promise<Server>((resolve) => {
    const listening = createOperatorApp(desk, lease).listen(port, "127.0.0.1", () => resolve(listening));
  });
  process.stdout.write(`Operator console: ${url}\n`);

  return {
    surface: new LeasedSurface(inner, lease, lease.automation),
    escalation: desk.escalate,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function discover(args: Args): Promise<number> {
  const goal = args.values.get("goal");
  const url = args.values.get("url");
  if (goal === undefined || url === undefined) {
    process.stderr.write("discover requires --goal and --url\n\n" + usage());
    return 1;
  }

  const entry = readUrl(url, "--url");
  if (entry === null) return 1;

  // Credentials are declared, not typed into the goal. Each --secret-env value
  // is registered for redaction before the run writes anything, and substituted
  // for its {{VAR}} placeholder only in the goal handed to the model.
  const secrets: string[] = [];
  let resolvedGoal = goal;
  for (const variable of args.multi.get("secret-env") ?? []) {
    const value = process.env[variable];
    if (value === undefined || value === "") {
      process.stderr.write(`--secret-env ${variable}: environment variable is not set\n`);
      return 1;
    }
    secrets.push(value);
    redactor.registerSecret(value);
    resolvedGoal = resolvedGoal.split(`{{${variable}}}`).join(value);
  }
  const unresolved = resolvedGoal.match(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g);
  if (unresolved !== null) {
    process.stderr.write(`--goal uses ${[...new Set(unresolved)].join(", ")} but no matching --secret-env was given\n`);
    return 1;
  }
  // What the goal looks like with only declared secrets and known patterns
  // masked. If it redacts differently after the run, the agent typed a
  // credential into a password field that nobody declared.
  const goalAsDeclared = redactor.redactText(resolvedGoal);

  // Checked before the run, so a recording that could not be saved costs nothing.
  const capabilityId = args.values.get("capability");
  if (capabilityId !== undefined && existsSync(join(CAPABILITY_DIR, `${capabilityId}.v1.json`))) {
    process.stderr.write(
      `${join(CAPABILITY_DIR, `${capabilityId}.v1.json`)} already exists. Versions are immutable: record under a ` +
        `new --capability id, or remove the old version deliberately first.\n`,
    );
    return 1;
  }

  const policy = new PolicyEngine(defaultPolicyConfig(entry.origin));
  const evidence = new EvidenceBus(newRunId("discovery"));
  const inner = await launchWebSurface({ headed: args.flags.has("headed") });

  process.stdout.write(`Run ${evidence.runId}\nEvidence: ${evidence.dir}\n`);
  const handoff = args.flags.has("escalate") ? await openOperatorConsole(inner, policy, evidence, args) : null;
  process.stdout.write("\n");

  try {
    const result = await runDiscovery({
      goal: resolvedGoal,
      secrets,
      entrypoint: url,
      surface: handoff?.surface ?? inner,
      policy,
      evidence,
      maxSteps: Number(args.values.get("max-steps") ?? 30),
      maxMs: Number(args.values.get("max-ms") ?? 300_000),
      onConfirm: args.flags.has("allow-risky") ? autoApprove : denyByDefault,
      maxCostUsd: Number(args.values.get("max-cost") ?? 0.75),
      ...(handoff === null ? {} : { escalation: handoff.escalation }),
      ...(args.values.has("effort")
        ? { effort: args.values.get("effort") as "low" | "medium" | "high" | "xhigh" | "max" }
        : {}),
    });

    process.stdout.write(
      [
        "",
        `Status:   ${result.status}`,
        `Summary:  ${result.summary}`,
        `Steps:    ${result.steps}`,
        `Elapsed:  ${(result.elapsedMs / 1000).toFixed(1)}s`,
        `Model:    ${result.usage.turns} turns, ~$${result.usage.costUsd.toFixed(4)}` +
          (result.usage.cacheWorking ? " (prompt cache active)" : " (NO cache reads - prefix is being invalidated)"),
        `Outputs:  ${Object.keys(result.outputs).length === 0 ? "(none)" : ""}`,
        ...Object.entries(result.outputs).map(([k, v]) => `  ${k} = ${v}`),
        ...(result.interventions === undefined || result.interventions.length === 0
          ? []
          : ["Handoffs:", ...result.interventions.map((i) => `  ${i.id} ${i.reason} -> ${i.resolution} by ${i.operator ?? "none"}`)]),
        "",
        "Trace:",
        ...result.trace.map(
          (s) =>
            `  ${String(s.index).padStart(2)}. ${s.action.kind.padEnd(9)} ${s.ok ? "ok " : "ERR"} ` +
            `${s.actor === "operator" ? "[operator] " : ""}${s.intent}`,
        ),
        "",
      ].join("\n"),
    );

    // Compilation is deliberately separate from the run: a trace is a record of
    // one exploration, an artifact is a reusable contract, and keeping the
    // boundary visible means a recording can be re-compiled without re-running
    // the model.
    if (redactor.redactText(resolvedGoal) !== goalAsDeclared) {
      process.stderr.write(
        "warning: the goal contained a credential that was not declared with --secret-env. It has been scrubbed " +
          "from the event log, but was on disk in the clear until the agent typed it. Write {{VAR}} in the goal " +
          "and pass --secret-env VAR instead.\n",
      );
    }

    if (result.status === "succeeded" && capabilityId !== undefined) {
      const { capability, notes } = compile(result, {
        id: capabilityId,
        name: capabilityId.replace(/_/g, " "),
        appProfileId: args.values.get("app-profile") ?? "meridian_core",
        discoveryRunId: evidence.runId,
        model: process.env["ANTHROPIC_MODEL"] ?? "claude-opus-5",
      });

      const file = join(CAPABILITY_DIR, `${capability.id}.v${capability.version}.json`);
      writeFileSync(file, `${JSON.stringify(capability, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

      process.stdout.write(
        [
          `Artifact: ${file}`,
          `  inputs:  ${capability.inputs.map((i) => `${i.name}:${i.type}(${i.sensitivity})`).join(", ") || "(none)"}`,
          `  outputs: ${capability.outputs.map((o) => `${o.name}:${o.type}`).join(", ") || "(none)"}`,
          `  steps:   ${capability.steps.length}`,
          "",
          "Compiler notes (review these):",
          ...notes.map((n) => `  - ${n}`),
          "",
        ].join("\n"),
      );
    }

    return result.status === "succeeded" ? 0 : 1;
  } finally {
    await handoff?.close();
    await inner.close();
  }
}

/**
 * Reads invocation arguments from the command line.
 *
 * Returns the problems rather than the values when anything is wrong, so a
 * caller can refuse before a browser is launched: a malformed invocation has no
 * side effects to report on, and there is nothing to be learned from watching
 * it fail against a live application.
 */
function collectInputs(capability: Capability, args: Args): { inputs: Record<string, string> } | { problems: string[] } {
  const secretNames = new Set(capability.inputs.filter((i) => i.sensitivity === "secret").map((i) => i.name));
  const inputs: Record<string, string> = {};
  const problems: string[] = [];

  for (const pair of args.multi.get("input") ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      problems.push(`--input expects name=value, got '${pair}'`);
      continue;
    }
    const name = pair.slice(0, eq);
    if (secretNames.has(name)) {
      process.stderr.write(
        `warning: '${name}' is a secret input passed on the command line. Prefer --input-env ${name}=VAR ` +
          `so it stays out of shell history and process listings.\n`,
      );
    }
    inputs[name] = pair.slice(eq + 1);
  }

  for (const pair of args.multi.get("input-env") ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      problems.push(`--input-env expects name=VARIABLE, got '${pair}'`);
      continue;
    }
    const variable = pair.slice(eq + 1);
    const value = process.env[variable];
    if (value === undefined) {
      problems.push(`environment variable ${variable} is not set`);
      continue;
    }
    inputs[pair.slice(0, eq)] = value;
  }

  // The same check replay applies internally, run early. A rejection here is
  // exactly a rejection there, because it is the same function.
  if (problems.length === 0) problems.push(...validateInputs(capability, inputs));
  return problems.length > 0 ? { problems } : { inputs };
}

/**
 * Loads an artifact through the shared loader, printing a readable problem
 * instead of throwing. Warnings, such as an approval that no longer holds, are
 * printed but do not stop the command: the capability simply runs as a draft.
 */
function loadArtifact(file: string): Capability | null {
  const loaded = readCapabilityFile(file);
  if (!loaded.ok) {
    process.stderr.write(`Cannot load ${file}: it ${loaded.problem}\n`);
    return null;
  }
  for (const warning of loaded.warnings) process.stderr.write(`warning: ${file} ${warning}\n`);
  return loaded.capability;
}

/** Replays a capability the caller has already resolved, by file or by catalog id. */
async function runReplay(capability: Capability, args: Args): Promise<number> {
  const collected = collectInputs(capability, args);
  if ("problems" in collected) {
    process.stderr.write(
      [
        `Cannot invoke ${capability.id} v${capability.version}:`,
        ...collected.problems.map((problem) => `  - ${problem}`),
        "",
        `Expected inputs: ${capability.inputs.map((i) => `${i.name}:${i.type}${i.required ? "" : "?"}`).join(", ") || "(none)"}`,
        "",
      ].join("\n"),
    );
    return 1;
  }
  const inputs = collected.inputs;

  const entrypoint = args.values.get("entrypoint") ?? capability.surface.entrypoint;
  const target = readUrl(entrypoint, "--entrypoint");
  if (target === null) return 1;

  const policy = new PolicyEngine(defaultPolicyConfig(target.origin));
  const evidence = new EvidenceBus(newRunId(`replay-${capability.id}`));
  // A fresh browser per invocation: a capability is recorded from a signed-out
  // start, so replay owns the session it runs in.
  const inner = await launchWebSurface({ headed: args.flags.has("headed") });

  process.stdout.write(`Run ${evidence.runId}\nEvidence: ${evidence.dir}\n`);
  const handoff = args.flags.has("escalate") ? await openOperatorConsole(inner, policy, evidence, args) : null;
  process.stdout.write("\n");

  try {
    const result = await replay({
      capability,
      inputs,
      surface: handoff?.surface ?? inner,
      policy,
      evidence,
      entrypoint,
      onConfirm: args.flags.has("approve-risky") ? autoApprove : denyByDefault,
      ...(handoff === null ? {} : { escalation: handoff.escalation }),
    });
    process.stdout.write(formatReplayResult(result));
    return exitCodeFor(result);
  } finally {
    await handoff?.close();
    await inner.close();
  }
}

async function replayCommand(args: Args): Promise<number> {
  const file = args.values.get("capability");
  if (file === undefined) {
    process.stderr.write("replay requires --capability <file>\n\n" + usage());
    return 1;
  }
  const capability = loadArtifact(file);
  return capability === null ? 1 : runReplay(capability, args);
}

/**
 * The catalog commands.
 *
 * `invoke` is the point of the catalog: a caller names a capability and its
 * inputs, and never has to know where the artifact lives or which version is
 * current. It runs the same replay engine as `replay --capability <file>` and
 * returns the same exit codes, because binding by id changes what is selected,
 * not how it executes.
 */
async function capabilitiesCommand(args: Args): Promise<number> {
  const [subcommand, id] = args.positionals;
  const dir = args.values.get("dir") ?? CAPABILITY_DIR;
  const catalog = Catalog.load(dir);

  if (subcommand === undefined || subcommand === "list") {
    process.stdout.write(formatCatalogList(catalog, dir));
    return catalog.problems.length > 0 ? 1 : 0;
  }

  if (subcommand === "tools") {
    process.stdout.write(`${JSON.stringify(catalog.toolDefinitions(), null, 2)}\n`);
    return 0;
  }

  if (subcommand !== "describe" && subcommand !== "invoke" && subcommand !== "approve") {
    process.stderr.write(`Unknown capabilities subcommand '${subcommand}'.\n\n${usage()}`);
    return 1;
  }

  if (id === undefined) {
    process.stderr.write(`capabilities ${subcommand} requires a capability id.\n\n${usage()}`);
    return 1;
  }

  const rawVersion = args.values.get("version");
  let version: number | undefined;
  if (rawVersion !== undefined) {
    // Checked beyond the digits: a long enough run of them parses to a float,
    // and reporting 'no version 1e+21' explains nothing.
    version = Number(rawVersion);
    if (!/^\d+$/.test(rawVersion) || !Number.isSafeInteger(version) || version < 1) {
      process.stderr.write(`--version expects a positive whole number, got '${rawVersion}'\n`);
      return 1;
    }
  }

  const resolution = catalog.resolve(id, version);
  if (!resolution.ok) {
    process.stderr.write(`${resolution.message}\n`);
    return 1;
  }

  if (subcommand === "describe") {
    process.stdout.write(formatCapabilityDescription(resolution.entry, resolution.selected));
    return 0;
  }

  if (subcommand === "approve") {
    const reviewer = args.values.get("reviewer")?.trim();
    if (reviewer === undefined || reviewer === "") {
      process.stderr.write("capabilities approve requires --reviewer <name>\n");
      return 1;
    }
    const { capability, file } = resolution.selected;
    const out = approvalRecordPath(file, capability.id, capability.version);
    const record = approvalRecordFor(capability, reviewer, args.values.get("note") ?? "");
    mkdirSync(dirname(out), { recursive: true });
    try {
      writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      process.stderr.write(
        `${out} already exists. An approval covers one version's exact content; a changed artifact is a new ` +
          `version and needs its own approval.\n`,
      );
      return 1;
    }
    const held = capability.steps.filter((s) => s.risk === "risky_irreversible").length;
    process.stdout.write(
      [
        `Approved ${capability.id} v${capability.version} (${out})`,
        `  digest: ${record.digest}`,
        `  ${held} declared irreversible step(s) will now run without a person confirming each one.`,
        "  Any edit to the artifact changes its digest and voids this approval.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // Refusing to run a capability whose profile is missing is not pedantry: its
  // outcome vocabulary lives there, so without it a legitimate business answer
  // would come back as a failure.
  const blockers = resolution.entry.blockers;
  if (blockers.length > 0) {
    process.stderr.write(`${id} cannot be replayed:\n${blockers.map((b) => `  - ${b}`).join("\n")}\n`);
    return 1;
  }

  const { capability } = resolution.selected;
  for (const problem of catalog.problems.filter((p) => p.file === resolution.selected.file)) {
    process.stderr.write(`warning: ${problem.file} ${problem.message}\n`);
  }
  process.stdout.write(`Capability: ${capability.id} v${capability.version} (${resolution.selected.file})\n`);
  return runReplay(capability, args);
}

async function reviseCommand(args: Args): Promise<number> {
  const file = args.values.get("capability");
  const reviewFile = args.values.get("review");
  if (file === undefined || reviewFile === undefined) {
    process.stderr.write("revise requires --capability <file> and --review <file>\n\n" + usage());
    return 1;
  }

  const base = loadArtifact(file);
  if (base === null) return 1;

  const reviewJson = readJsonFile(reviewFile);
  if (!reviewJson.ok) {
    process.stderr.write(`Cannot load ${reviewFile}: it ${reviewJson.problem}\n`);
    return 1;
  }
  const review = ReviewSchema.safeParse(reviewJson.value);
  if (!review.success) {
    process.stderr.write(
      `Cannot load ${reviewFile}: it is not a valid review:\n${describeSchemaError(review.error).map((l) => `  - ${l}`).join("\n")}\n`,
    );
    return 1;
  }

  let revised: Capability;
  try {
    revised = reviseCapability(base, review.data);
  } catch (error) {
    if (error instanceof RevisionError) {
      process.stderr.write(`Cannot apply ${reviewFile}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof z.ZodError) {
      process.stderr.write(
        `Cannot apply ${reviewFile}: the revised artifact would be invalid:\n${describeSchemaError(error).map((l) => `  - ${l}`).join("\n")}\n`,
      );
      return 1;
    }
    throw error;
  }
  const out = join("capabilities", `${revised.id}.v${revised.version}.json`);
  if (existsSync(out)) {
    process.stderr.write(`${out} already exists. Versions are immutable: a changed artifact is a new version.\n`);
    return 1;
  }
  writeFileSync(out, `${JSON.stringify(revised, null, 2)}\n`, "utf8");

  const latest = revised.provenance.revisions.at(-1);
  process.stdout.write(
    [
      `Wrote ${out}`,
      `  ${base.id} v${base.version} -> v${revised.version}, ${revised.approvalState} (needs approval before unattended use)`,
      ...(latest?.changes ?? []).map((change) => `  - ${change}`),
      "",
    ].join("\n"),
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return command === undefined ? 1 : 0;
  }

  if (!isCommand(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  switch (command) {
    case "discover":
      return discover(parseArgs(rest));
    case "replay":
      return replayCommand(parseArgs(rest));
    case "revise":
      return reviseCommand(parseArgs(rest));
    case "capabilities":
      return capabilitiesCommand(parseArgs(rest));
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Anything that reaches here is unexpected. A stack trace is noise to
    // someone running a command and can carry absolute paths, so it is shown
    // only when asked for.
    const debug = process.env["CUA_DEBUG"] === "1";
    const detail = error instanceof Error ? (debug ? (error.stack ?? error.message) : error.message) : String(error);
    process.stderr.write(`error: ${detail}\n${debug ? "" : "(set CUA_DEBUG=1 for a stack trace)\n"}`);
    process.exitCode = 1;
  },
);
