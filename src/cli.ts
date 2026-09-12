/**
 * Entry point for the computer-use automation system.
 *
 *   discover      LLM-driven run against a live surface; emits a capability artifact.
 *   replay        Deterministic execution of a saved artifact. No model in the loop.
 *   capabilities  List / describe / invoke saved artifacts as typed capabilities.
 *   operator      Minimal human-in-the-loop surface for escalation and handoff.
 */

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
  return `Usage: npm run cua -- <command> [options]\n\nCommands:\n${rows}\n`;
}

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMANDS, value);
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return command === undefined ? 1 : 0;
  }

  if (!isCommand(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

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
