import { beforeEach, describe, expect, it } from "vitest";

import type { ObservedElement } from "../src/perception/types.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { Redactor, redactor } from "../src/policy/redactor.js";
import { defaultPolicyConfig, type PolicyContext } from "../src/policy/types.js";

const ORIGIN = "http://127.0.0.1:4173";
const engine = new PolicyEngine(defaultPolicyConfig(ORIGIN));

const DISCOVERY: PolicyContext = { mode: "discovery" };

function element(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    nodeId: 1,
    role: "button",
    name: "Search",
    value: null,
    enabled: true,
    visible: true,
    framePath: ["main"],
    anchorText: null,
    hints: { tag: "input", inputType: "submit", domId: null, fieldName: null },
    ...overrides,
  };
}

describe("allowlist — deny by default", () => {
  it("permits the configured origin", () => {
    expect(engine.checkLocation(`${ORIGIN}/content`).verdict).toBe("allow");
  });

  it("denies any other origin", () => {
    const d = engine.checkLocation("https://evil.example.com/content");
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("origin-allowlist");
  });

  it("denies the fault control plane even on the permitted origin", () => {
    // An agent that can arm faults against its own target can manufacture the
    // conditions it is being evaluated on.
    const d = engine.checkLocation(`${ORIGIN}/_control/fault`);
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("path-denylist");
  });

  it("denies a malformed URL rather than passing it through", () => {
    expect(engine.checkLocation("not-a-url").verdict).toBe("deny");
  });

  it("denies an action verb outside the permitted set", () => {
    const narrow = new PolicyEngine({
      ...defaultPolicyConfig(ORIGIN),
      allowedActions: ["read", "wait"],
    });
    const d = narrow.check({ kind: "click", nodeId: 1 }, DISCOVERY, element());
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("action-allowlist");
  });

  it("denies navigation off-origin at the action gate, not just the URL checker", () => {
    const d = engine.check({ kind: "navigate", url: "https://evil.example.com" }, DISCOVERY);
    expect(d.verdict).toBe("deny");
  });
});

describe("risk classification", () => {
  it("treats reading, typing and waiting as reversible", () => {
    expect(engine.check({ kind: "read", nodeId: 1 }, DISCOVERY, element()).verdict).toBe("allow");
    expect(
      engine.check({ kind: "fill", nodeId: 1, value: "12345" }, DISCOVERY, element({ role: "textbox" }))
        .verdict,
    ).toBe("allow");
    expect(engine.check({ kind: "wait", ms: 10 }, DISCOVERY).verdict).toBe("allow");
  });

  it("treats a benign click as reversible", () => {
    const d = engine.check({ kind: "click", nodeId: 1 }, DISCOVERY, element({ name: "Back to Search" }));
    expect(d.verdict).toBe("allow");
  });

  it("requires confirmation before an irreversible click", () => {
    const d = engine.check({ kind: "click", nodeId: 1 }, DISCOVERY, element({ name: "Open Account" }));
    expect(d.verdict).toBe("confirm");
    expect(d.rule).toBe("risky-irreversible");
    expect(d.reason).toContain("Open Account");
  });

  it("classifies on anchor text when the control has no accessible name", () => {
    // The unlabelled-control case again: risk has to be readable from what a
    // human operator sees, not from an accessible name that does not exist.
    const d = engine.check(
      { kind: "click", nodeId: 1 },
      DISCOVERY,
      element({ name: "", anchorText: "Transfer Funds" }),
    );
    expect(d.verdict).toBe("confirm");
  });

  it("honours the artifact's declared risk on replay over inference", () => {
    // The control reads as benign, but the artifact says otherwise. The
    // reviewed judgement wins.
    const d = engine.check(
      { kind: "click", nodeId: 1 },
      { mode: "replay", declaredRisk: "risky_irreversible", capabilityApproved: false },
      element({ name: "Continue" }),
    );
    expect(d.verdict).toBe("confirm");
  });

  it("lets an approved capability run its reviewed risky step unattended", () => {
    const d = engine.check(
      { kind: "click", nodeId: 1 },
      { mode: "replay", declaredRisk: "risky_irreversible", capabilityApproved: true },
      element({ name: "Open Account" }),
    );
    expect(d.verdict).toBe("allow");
    expect(d.rule).toBe("approved-capability");
  });

  it("still gates a draft capability's risky step on replay", () => {
    const d = engine.check(
      { kind: "click", nodeId: 1 },
      { mode: "replay", declaredRisk: "risky_irreversible", capabilityApproved: false },
      element({ name: "Open Account" }),
    );
    expect(d.verdict).toBe("confirm");
  });
});

describe("secret capture is automatic, not caller-dependent", () => {
  it("registers a password typed into a password field", () => {
    const before = redactor.secretCount;
    engine.check(
      { kind: "fill", nodeId: 1, value: "hunter2-not-real" },
      DISCOVERY,
      element({ role: "textbox", name: "Password", hints: { tag: "input", inputType: "password", domId: null, fieldName: "password" } }),
    );
    expect(redactor.secretCount).toBe(before + 1);
    expect(redactor.redactText("typed hunter2-not-real into the form")).not.toContain("hunter2-not-real");
  });

  it("does not register ordinary field values", () => {
    const before = redactor.secretCount;
    engine.check(
      { kind: "fill", nodeId: 1, value: "12345" },
      DISCOVERY,
      element({ role: "textbox", name: "Member ID" }),
    );
    expect(redactor.secretCount).toBe(before);
  });
});

describe("redaction", () => {
  let r: Redactor;
  beforeEach(() => {
    r = new Redactor();
  });

  it("masks registered secrets everywhere they appear later", () => {
    r.registerSecret("s3cr3t-value");
    const out = r.redactText("login with s3cr3t-value then retry with s3cr3t-value");
    expect(out).not.toContain("s3cr3t-value");
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("masks API keys, bearer tokens and SSNs", () => {
    expect(r.redactText("key sk-ant-abcdefgh12345")).toContain("[REDACTED]");
    expect(r.redactText("Authorization: Bearer abcdefghijklmnop")).toContain("[REDACTED]");
    expect(r.redactText("ssn 123-45-6789 on file")).toContain("[REDACTED]");
  });

  it("masks a card number that passes Luhn", () => {
    expect(r.redactText("card 4242424242424242 charged")).toContain("[REDACTED]");
  });

  it("leaves business data readable — the point of redacting by classification", () => {
    // These are the capability's declared outputs. Masking them would defeat
    // the purpose of capturing evidence at all.
    const text = "account 0002-8891 Savings balance $14,820.37";
    expect(r.redactText(text)).toBe(text);
  });

  it("does not mask a long identifier that fails Luhn", () => {
    const text = "reference 1234567890123456 recorded";
    expect(r.redactText(text)).toBe(text);
  });

  it("masks values under credential-shaped keys wholesale", () => {
    const out = r.redactDeep({
      operator: "op-demo",
      password: "anything at all",
      headers: { authorization: "Bearer xyz" },
      memberId: "12345",
    }) as Record<string, unknown>;

    expect(out["password"]).toBe("[REDACTED]");
    expect((out["headers"] as Record<string, unknown>)["authorization"]).toBe("[REDACTED]");
    // Non-credential fields survive intact.
    expect(out["operator"]).toBe("op-demo");
    expect(out["memberId"]).toBe("12345");
  });

  it("reports what it redacted, for evidence auditability", () => {
    r.registerSecret("topsecret");
    const report = r.redactTextWithReport("topsecret and ssn 123-45-6789");
    expect(report.counts["registered-secret"]).toBe(1);
    expect(report.counts["ssn"]).toBe(1);
  });

  it("ignores secrets too short to register safely", () => {
    r.registerSecret("ab");
    expect(r.secretCount).toBe(0);
    expect(r.redactText("ab is a common substring")).toBe("ab is a common substring");
  });
});
