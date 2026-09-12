import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../apps/legacy-demo/server.js";
import { DesktopSurface, DesktopSurfaceNotImplementedError } from "../src/perception/desktop.js";
import { launchWebSurface, type PlaywrightWebSurface } from "../src/perception/web-playwright.js";
import type { ObservedElement, Surface } from "../src/perception/types.js";

let server: Server;
let base: string;
let surface: PlaywrightWebSurface;

const find = (
  els: readonly ObservedElement[],
  pred: (e: ObservedElement) => boolean,
): ObservedElement | undefined => els.find(pred);

/**
 * Signs on and lands on the frameset.
 *
 * Starts from /logout so it is idempotent. The browser keeps its session cookie
 * between tests, so a bare navigate to / would serve the frameset rather than
 * the sign-on form and the login controls would not exist.
 */
async function signOn(): Promise<void> {
  await surface.act({ kind: "navigate", url: `${base}/logout` });
  let obs = await surface.observe();

  const operator = find(obs.elements, (e) => e.name === "Operator ID");
  const password = find(obs.elements, (e) => e.name === "Password");
  const submit = find(obs.elements, (e) => e.role === "button" && e.name === "Sign On");
  if (!operator || !password || !submit) throw new Error("sign-on controls not observed");

  await surface.act({ kind: "fill", nodeId: operator.nodeId, value: "op-test" });
  await surface.act({ kind: "fill", nodeId: password.nodeId, value: "demo" });
  await surface.act({ kind: "click", nodeId: submit.nodeId });

  obs = await surface.observe();
  if (obs.framePaths.length < 2) throw new Error("frameset did not load");
}

beforeAll(async () => {
  await new Promise<void>((done) => {
    server = createApp().listen(0, "127.0.0.1", () => done());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
  surface = await launchWebSurface({ settleMs: 150 });
}, 60_000);

afterAll(async () => {
  await surface.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("observation", () => {
  it("observes controls on the sign-on page with accessible names", async () => {
    await surface.act({ kind: "navigate", url: base });
    const obs = await surface.observe();

    expect(obs.title).toBe("Sign On");
    expect(find(obs.elements, (e) => e.name === "Operator ID")?.role).toBe("textbox");
    expect(find(obs.elements, (e) => e.name === "Password")?.role).toBe("textbox");
    expect(find(obs.elements, (e) => e.name === "Sign On")?.role).toBe("button");
  }, 30_000);

  it("assigns unique nodeIds and includes a readable tree", async () => {
    await surface.act({ kind: "navigate", url: base });
    const obs = await surface.observe();

    const ids = obs.elements.map((e) => e.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(obs.tree).toContain("textbox");
    expect(obs.tree).toContain("# frame:");
  }, 30_000);

  it("sees into every frame of the frameset", async () => {
    await signOn();
    const obs = await surface.observe();

    // Top document plus the nav and main frames.
    expect(obs.framePaths.length).toBeGreaterThanOrEqual(2);
    const paths = obs.framePaths.map((p) => p.join("/"));
    expect(paths).toContain("navmenu");
    expect(paths).toContain("main");

    // Controls from different frames coexist in one flat, addressable list.
    const inNav = obs.elements.filter((e) => e.framePath.join("/") === "navmenu");
    const inMain = obs.elements.filter((e) => e.framePath.join("/") === "main");
    expect(inNav.length).toBeGreaterThan(0);
    expect(inMain.length).toBeGreaterThan(0);
  }, 40_000);
});

/** Drives the full flow to the sub-account form. Self-contained by design. */
async function gotoSubAccountForm(): Promise<void> {
  await signOn();

  let obs = await surface.observe();
  const memberId = find(obs.elements, (e) => e.name === "Member ID");
  const search = find(obs.elements, (e) => e.role === "button" && e.name === "Search");
  if (!memberId || !search) throw new Error("search controls not observed");

  await surface.act({ kind: "fill", nodeId: memberId.nodeId, value: "12345" });
  await surface.act({ kind: "click", nodeId: search.nodeId });

  obs = await surface.observe();
  const open = find(obs.elements, (e) => e.name === "Open Sub-Account");
  if (!open) throw new Error("sub-account button not observed");
  await surface.act({ kind: "click", nodeId: open.nodeId });
}

describe("the unnamed control — the case that justifies anchored targeting", () => {
  it("reports an empty accessible name and a usable anchor", async () => {
    await gotoSubAccountForm();

    const obs = await surface.observe();
    const deposit = find(obs.elements, (e) => e.hints.fieldName === "deposit");
    expect(deposit).toBeDefined();

    // The whole point: no accessible name, so name-based targeting is out...
    expect(deposit!.name).toBe("");
    expect(deposit!.role).toBe("textbox");
    // ...but the surface captured what a human reads instead.
    expect(deposit!.anchorText).toBe("Initial Deposit");

    // And no other control on the form shares that anchor, so it discriminates.
    const sameAnchor = obs.elements.filter((e) => e.anchorText === "Initial Deposit");
    expect(sameAnchor).toHaveLength(1);

    // Neighbouring fields DO have names — the surface is not simply failing.
    expect(find(obs.elements, (e) => e.hints.fieldName === "reference")?.name).toBe("Reference");
    expect(find(obs.elements, (e) => e.hints.fieldName === "accountType")?.name).toBe("Account Type");
  }, 60_000);

  it("can be filled and read back through the observation handle", async () => {
    await gotoSubAccountForm();

    const obs = await surface.observe();
    const deposit = find(obs.elements, (e) => e.hints.fieldName === "deposit");
    if (!deposit) throw new Error("deposit field not observed");

    const filled = await surface.act({ kind: "fill", nodeId: deposit.nodeId, value: "500.00" });
    expect(filled.ok).toBe(true);

    const read = await surface.act({ kind: "read", nodeId: deposit.nodeId });
    expect(read.ok).toBe(true);
    expect(read.text).toBe("500.00");
  }, 30_000);
});

describe("action contract", () => {
  it("fails cleanly on a stale nodeId instead of acting on the wrong control", async () => {
    const result = await surface.act({ kind: "click", nodeId: 99_999 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("99999");
  });

  it("produces screenshot bytes for evidence", async () => {
    const png = await surface.screenshot();
    expect(png.byteLength).toBeGreaterThan(1000);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  }, 30_000);
});

describe("the desktop seam", () => {
  it("satisfies the Surface contract structurally", () => {
    // If DesktopSurface ever drifts from the interface this stops compiling,
    // which is the entire value of keeping the stub typed.
    const asSurface: Surface = new DesktopSurface({ windowTitle: "Core", backend: "uia" });
    expect(asSurface).toBeInstanceOf(DesktopSurface);
  });

  it("throws honestly rather than returning a fake observation", () => {
    const desktop = new DesktopSurface({ windowTitle: "Core", backend: "uia" });
    expect(() => desktop.observe()).toThrow(DesktopSurfaceNotImplementedError);
    expect(() => desktop.act({ kind: "wait", ms: 1 })).toThrow(/not implemented/);
  });
});
