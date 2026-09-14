/**
 * What a person sees when they point the CLI at a bad artifact.
 *
 * Spawned for real, because the failure this guards against lived at the top of
 * the process: an unreadable file threw, and the uncaught error was printed as a
 * stack trace full of absolute paths. An in-process test of the loader cannot
 * see that; running the CLI can.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TSX = resolve("node_modules", "tsx", "dist", "cli.mjs");
const root = mkdtempSync(join(tmpdir(), "cua-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cli(...args: string[]): { status: number | null; output: string; stderr: string } {
  const run = spawnSync(process.execPath, [TSX, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: run.status, stderr: run.stderr, output: `${run.stdout}\n${run.stderr}` };
}

function expectNoInternals(output: string): void {
  expect(output).not.toMatch(/^\s+at\s/m);
  expect(output).not.toContain("ZodError");
  expect(output).not.toContain("node_modules");
  expect(output).not.toContain(resolve("src"));
}

describe("replay reports a bad artifact as a sentence, not a stack trace", () => {
  it("malformed JSON", () => {
    const file = join(root, "malformed.json");
    writeFileSync(file, '{"schemaVersion": 1, "id": "oops",', "utf8");
    const run = cli("replay", "--capability", file);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not valid JSON");
    expectNoInternals(run.output);
  }, 130_000);

  it("a schema violation, naming the field at fault", () => {
    const artifact = JSON.parse(readFileSync(join("capabilities", "lookup_member_savings_balance.v2.json"), "utf8")) as {
      steps: { action: string }[];
    };
    artifact.steps[3]!.action = "teleport";
    const file = join(root, "invalid.json");
    writeFileSync(file, JSON.stringify(artifact), "utf8");
    const run = cli("replay", "--capability", file);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("steps[3].action");
    expectNoInternals(run.output);
  }, 130_000);

  it("a file that does not exist", () => {
    const run = cli("replay", "--capability", join(root, "nope.json"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not exist");
    expectNoInternals(run.output);
  }, 130_000);
});
