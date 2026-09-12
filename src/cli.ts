/**
 * Entry point for the computer-use automation system.
 *
 *   discover      LLM-driven run against a live surface; emits a capability artifact.
 *   replay        Deterministic execution of a saved artifact. No model in the loop.
 *   capabilities  List / describe / invoke saved artifacts as typed capabilities.
 *   operator      Minimal human-in-the-loop surface for escalation and handoff.
 */

import "dotenv/config";

import { autoApprove, denyByDefault, runDiscovery } from "./agent/loop.js";
import { EvidenceBus, newRunId } from "./evidence/bus.js";
import { launchWebSurface } from "./perception/web-playwright.js";
import { PolicyEngine } from "./policy/engine.js";
import { defaultPolicyConfig } from "./policy/types.js";

type Command = "discover" | "replay" | "capabilities" | "operator";

const COMMANDS: Record<Command, string> = {
  discover: "Run the agent against a goal and record a capability artifact",
  replay: "Replay a saved capability artifact with typed input parameters",
  capabilities: "List, describe, or invoke saved capabilities",
  operator: "Serve the operator surface for intervention requests",
};

function usage(): string {
  const rows = Object.entries(COMMANDS)
    .map(([name, description]) => `  ${name.padEnd(14)}${description}`)
    .join("\n");
  return `Usage: npm run cua -- <command> [options]

Commands:
${rows}

discover options:
  --goal <text>        Natural-language goal (required)
  --url <url>          Entrypoint URL (required)
  --max-steps <n>      Step budget (default 30)
  --max-ms <n>         Wall-clock budget in ms (default 300000)
  --headed             Show the browser window
  --allow-risky        Auto-approve irreversible actions instead of refusing them.
                       Use only for a supervised recording run.
  --max-cost <usd>     Hard ceiling on estimated model spend (default 0.75)
  --effort <level>     low|medium|high|xhigh|max (default from ANTHROPIC_EFFORT)
`;
}

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMANDS, value);
}

interface Args {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

async function discover(args: Args): Promise<number> {
  const goal = args.values.get("goal");
  const url = args.values.get("url");
  if (goal === undefined || url === undefined) {
    process.stderr.write("discover requires --goal and --url\n\n" + usage());
    return 1;
  }

  const origin = new URL(url).origin;
  const evidence = new EvidenceBus(newRunId("discovery"));
  const surface = await launchWebSurface({ headed: args.flags.has("headed") });

  process.stdout.write(`Run ${evidence.runId}\nEvidence: ${evidence.dir}\n\n`);

  try {
    const result = await runDiscovery({
      goal,
      entrypoint: url,
      surface,
      policy: new PolicyEngine(defaultPolicyConfig(origin)),
      evidence,
      maxSteps: Number(args.values.get("max-steps") ?? 30),
      maxMs: Number(args.values.get("max-ms") ?? 300_000),
      onConfirm: args.flags.has("allow-risky") ? autoApprove : denyByDefault,
      maxCostUsd: Number(args.values.get("max-cost") ?? 0.75),
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
        "",
        "Trace:",
        ...result.trace.map(
          (s) =>
            `  ${String(s.index).padStart(2)}. ${s.action.kind.padEnd(9)} ${s.ok ? "ok " : "ERR"} ${s.intent}`,
        ),
        "",
      ].join("\n"),
    );

    return result.status === "succeeded" ? 0 : 1;
  } finally {
    await surface.close();
  }
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

  if (command === "discover") return discover(parseArgs(rest));

  process.stderr.write(`'${command}' is not implemented yet.\n`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
