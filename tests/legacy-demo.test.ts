import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../apps/legacy-demo/server.js";

let server: Server;
let base: string;

/** Signs on and returns the session cookie header value. */
async function signOn(): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ operator: "op-test", password: "demo" }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}

async function get(path: string, cookie: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.text() };
}

async function post(
  path: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { status: res.status, body: await res.text() };
}

async function armFault(fields: Record<string, string>): Promise<void> {
  await fetch(`${base}/_control/fault`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

async function reset(): Promise<void> {
  await fetch(`${base}/_control/reset`, { method: "POST" });
}

beforeAll(async () => {
  await new Promise<void>((done) => {
    server = createApp().listen(0, "127.0.0.1", () => done());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("authentication", () => {
  it("serves the sign-on page when unauthenticated", async () => {
    const res = await fetch(base);
    expect(await res.text()).toContain("Sign On");
  });

  it("serves the frameset once signed on", async () => {
    const cookie = await signOn();
    const { body } = await get("/", cookie);
    // The frameset shell is the point: automation must cope with frames.
    expect(body).toContain("<frameset");
    expect(body).toContain('name="main"');
  });

  it("rejects a bad password", async () => {
    const { body } = await post("/login", "", { operator: "op", password: "wrong" });
    expect(body).toContain("Sign-on failed");
  });
});

describe("business outcomes — legitimate answers, not failures", () => {
  it("reports an unknown member as not found", async () => {
    const cookie = await signOn();
    const { body } = await post("/members/search", cookie, { memberId: "99999" });
    expect(body).toContain("No member found for ID 99999");
  });

  it("reports a restricted member as not authorized", async () => {
    const cookie = await signOn();
    const { body } = await post("/members/search", cookie, { memberId: "55555" });
    expect(body).toContain("Not authorized to view member 55555");
  });

  it("returns balances for a known member", async () => {
    const cookie = await signOn();
    const { body } = await post("/members/search", cookie, { memberId: "12345" });
    expect(body).toContain("Dolores Abernathy");
    expect(body).toContain("$14,820.37");
  });

  it("rejects a deposit below the minimum", async () => {
    const cookie = await signOn();
    const { body } = await post("/members/12345/subaccount", cookie, {
      accountType: "Savings",
      deposit: "10",
    });
    expect(body).toContain("at least $25.00");
  });

  it("reaches the confirmation screen on a valid open", async () => {
    const cookie = await signOn();
    const { body } = await post("/members/12345/subaccount", cookie, {
      accountType: "Savings",
      deposit: "500.00",
    });
    expect(body).toContain("Sub-Account Opened");
    expect(body).toContain("$500.00");
  });
});

describe("injected runtime faults", () => {
  it("fires an interstitial once, then clears itself", async () => {
    await reset();
    const cookie = await signOn();
    await armFault({ kind: "interstitial", pathPrefix: "/content" });

    const first = await get("/content", cookie);
    expect(first.body).toContain("Scheduled maintenance notice");

    const second = await get("/content", cookie);
    expect(second.body).toContain("Member Search");
  });

  it("returns a 500 for server_error", async () => {
    await reset();
    const cookie = await signOn();
    await armFault({ kind: "server_error", pathPrefix: "/content" });
    const { status, body } = await get("/content", cookie);
    expect(status).toBe(500);
    expect(body).toContain("Unexpected error");
  });

  it("delays the response for slow_load", async () => {
    await reset();
    const cookie = await signOn();
    await armFault({ kind: "slow_load", pathPrefix: "/content", delayMs: "300" });
    const started = Date.now();
    await get("/content", cookie);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("destroys the session for session_expired", async () => {
    await reset();
    const cookie = await signOn();
    await armFault({ kind: "session_expired", pathPrefix: "/content" });

    expect((await get("/content", cookie)).body).toContain("session has timed out");
    // The session is genuinely gone, not just this one response.
    expect((await get("/content", cookie)).body).toContain("Sign On");
  });

  it("honours a multi-shot arming count", async () => {
    await reset();
    await armFault({ kind: "slow_load", times: "3", delayMs: "1" });
    const state = await (await fetch(`${base}/_control/state`)).json();
    expect(state.armedFault.remaining).toBe(3);
    await reset();
  });
});

describe("hostile surface properties", () => {
  it("exposes no test IDs anywhere in the servicing flow", async () => {
    const cookie = await signOn();
    const pages = [
      (await get("/content", cookie)).body,
      (await post("/members/search", cookie, { memberId: "12345" })).body,
      (await get("/members/12345/subaccount/new", cookie)).body,
    ];
    for (const body of pages) {
      expect(body).not.toMatch(/data-testid|data-test|data-qa/i);
    }
  });

  it("leaves the Initial Deposit field without an accessible name", async () => {
    // This is the load-bearing hostile property: the field's only identity is
    // the adjacent cell text, so role+name targeting cannot reach it and the
    // replay engine's anchored-relative fallback has to carry the step.
    const cookie = await signOn();
    const { body } = await get("/members/12345/subaccount/new", cookie);

    expect(body).toContain("<td>Initial Deposit</td>");
    expect(body).toMatch(/<input type="text" name="deposit"[^>]*>/);

    const depositInput = /<input type="text" name="deposit"[^>]*>/.exec(body)![0];
    expect(depositInput).not.toContain("aria-label");
    expect(depositInput).not.toContain("placeholder");
    expect(depositInput).not.toContain("id=");
    expect(body).not.toMatch(/<label[^>]*>\s*Initial Deposit\s*<\/label>/);
  });
});
