import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Guards a failure this project actually shipped and had to debug against a
 * live model run.
 *
 * `collectMeta` and `collectReadable` are stringified and executed inside the
 * browser. esbuild's keepNames transform rewrites `const helper = () => {}`
 * into `const helper = __name(() => {}, "helper")`, and `__name` does not exist
 * in the page — so the evaluate throws ReferenceError, every observation comes
 * back with zero elements, and the agent correctly concludes the application is
 * blank and escalates.
 *
 * The reason this needs its own file, and needs to shell out, is the part worth
 * remembering: vitest and tsx do not use the same esbuild settings. Vitest
 * never injects the helper, so the entire perception suite passed while the
 * real CLI path was completely broken. An in-process test cannot see this bug
 * by construction — spawning tsx is the only way to exercise the transform the
 * CLI actually uses.
 */

const dir = mkdtempSync(join(tmpdir(), "cua-guard-"));

/**
 * Absolute specifier for the module under test. The probe script lives in a
 * temp directory, so a relative import would resolve against that directory
 * rather than the project.
 */
const SURFACE = pathToFileURL(resolve("src/perception/web-playwright.ts")).href;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a script through tsx — the same transform the CLI uses — and returns stdout. */
function runUnderTsx(source: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, source, "utf8");
  return execFileSync("npx", ["tsx", file], {
    encoding: "utf8",
    timeout: 120_000,
    shell: true,
    cwd: process.cwd(),
  });
}

describe("in-page functions survive the tsx transform", () => {
  it("loads the surface module under tsx without tripping the startup guard", () => {
    // assertSerializable() runs at module load and throws if a bundler helper
    // reached the function bodies.
    const out = runUnderTsx(
      `import ${JSON.stringify(SURFACE)};\nconsole.log("GUARD_OK");\n`,
      "load.ts",
    );
    expect(out).toContain("GUARD_OK");
  }, 130_000);

  it("ships in-page sources free of bundler helpers", () => {
    // Asserts on the string the browser will actually receive, not on what the
    // source file looks like before transformation.
    const out = runUnderTsx(
      [
        `import { __inPageSources } from ${JSON.stringify(SURFACE)};`,
        `const src = __inPageSources().join("\\n");`,
        `const bad = ["__name", "__publicField", "__toESM", "__commonJS"].filter((h) => src.includes(h));`,
        `console.log(bad.length === 0 ? "CLEAN" : "DIRTY:" + bad.join(","));`,
      ].join("\n"),
      "sources.ts",
    );
    expect(out).toContain("CLEAN");
  }, 130_000);
});
