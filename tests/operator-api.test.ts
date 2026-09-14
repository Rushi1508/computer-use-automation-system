/**
 * The operator console's error contract.
 *
 * The console is reachable over HTTP, so what it says when a request is wrong is
 * part of its attack surface. Express's default error handler answers a
 * malformed JSON body with an HTML page carrying the stack trace and absolute
 * file paths. Every failure here must come back as JSON that names the caller's
 * mistake and nothing about the server.
 */

import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HandoffDesk } from "../src/escalation/desk.js";
import { createOperatorApp } from "../src/escalation/operator-server.js";
import { EvidenceBus, newRunId } from "../src/evidence/bus.js";
import type { Observation, Surface } from "../src/perception/types.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/types.js";
import { SessionLease } from "../src/session/lease.js";

const SCRATCH = join(".runs", "__test_operator_api__");
const ORIGIN = "http://127.0.0.1:4173";

const observation: Observation = {
  url: `${ORIGIN}/`,
  title: "Sign On",
  framePaths: [[]],
  elements: [],
  tree: "",
  capturedAt: "",
  warnings: [],
};

const surface: Surface = {
  observe: async () => observation,
  act: async () => ({ ok: true }),
  screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  close: async () => {},
};

let server: Server;
let base: string;

beforeAll(async () => {
  const lease = new SessionLease();
  const desk = new HandoffDesk({
    surface,
    lease,
    policy: new PolicyEngine(defaultPolicyConfig(ORIGIN)),
    evidence: new EvidenceBus(newRunId("test-operator-api"), SCRATCH),
  });
  server = await new Promise<Server>((resolve) => {
    const listening = createOperatorApp(desk, lease).listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** Asserts a failure came back as a small JSON error that leaks nothing about the server, and returns it. */
async function safeError(response: Response): Promise<string> {
  const text = await response.text();
  expect(response.headers.get("content-type") ?? "").toContain("application/json");
  expect(text).not.toMatch(/<html|<!doctype|<pre>/i);
  expect(text).not.toMatch(/\bat .+:\d+:\d+/);
  expect(text).not.toContain("node_modules");
  expect(text.includes(process.cwd()) || text.includes(JSON.stringify(process.cwd()).slice(1, -1))).toBe(false);
  const body = JSON.parse(text) as { error?: unknown };
  expect(typeof body.error).toBe("string");
  return String(body.error);
}

const post = (path: string, body: string): Promise<Response> =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("the operator console answers bad requests in JSON and leaks nothing", () => {
  it("a malformed JSON body", async () => {
    const response = await post("/api/interventions/int-001/claim", '{"operator": "alice",');
    expect(response.status).toBe(400);
    expect(await safeError(response)).toBe("request body is not valid JSON");
  });

  it("an oversized body", async () => {
    const response = await post("/api/interventions/int-001/claim", JSON.stringify({ operator: "alice", pad: "x".repeat(100_000) }));
    expect(response.status).toBe(413);
    expect(await safeError(response)).toBe("request body is too large");
  });

  it("an endpoint that does not exist", async () => {
    const response = await fetch(`${base}/api/nothing-here`);
    expect(response.status).toBe(404);
    await safeError(response);
  });

  it("a request with no operator identity", async () => {
    const response = await post("/api/interventions/int-001/claim", "{}");
    expect(response.status).toBe(400);
    expect(await safeError(response)).toContain("operator");
  });

  it("an action the console does not recognise", async () => {
    const response = await post("/api/interventions/int-001/act", JSON.stringify({ operator: "alice", action: { kind: "teleport" } }));
    expect(response.status).toBe(400);
    await safeError(response);
  });

  it("an intervention that does not exist", async () => {
    const response = await post("/api/interventions/int-999/claim", JSON.stringify({ operator: "alice" }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await safeError(response);
  });
});
