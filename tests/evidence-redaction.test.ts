import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { customerIdentifiers } from "../apps/legacy-demo/data.js";
import { redactIdentifiers, screenshotMask } from "../scripts/evidence-redaction.js";

describe("publication redaction of the committed evidence", () => {
  it("replaces names, branches and account numbers with markers", () => {
    const text = "Looked up member 12345 (Dolores Abernathy, Westworld Main); savings account 0002-8891 balance is $14,820.37.";
    expect(redactIdentifiers(text)).toBe(
      "Looked up member 12345 ([member name], [branch]); savings account [account number] balance is $14,820.37.",
    );
  });

  it("leaves timestamps, run ids, ports, dates and balances alone", () => {
    const text =
      '{"at":"2026-09-14T22:10:03.123Z","runId":"discovery-2026-09-14T22-10-03","url":"http://127.0.0.1:4173/","opened":"2019-03-14","balance":"$25,000.00"}';
    expect(redactIdentifiers(text)).toBe(text);
  });

  it("keeps JSON valid", () => {
    const json = JSON.stringify({ summary: "Opened 0009-4000 for Dolores Abernathy" });
    expect(JSON.parse(redactIdentifiers(json))).toEqual({ summary: "Opened [account number] for [member name]" });
  });

  it("masks the same identifiers in screenshots, and not dates", () => {
    const mask = screenshotMask();
    expect(mask.texts).toContain("Dolores Abernathy");
    expect(mask.patterns.some((pattern) => pattern.test("0002-8891"))).toBe(true);
    expect(mask.patterns.some((pattern) => pattern.test("2019-03-14"))).toBe(false);
  });
});

describe("the committed evidence", () => {
  it("contains no customer name, branch or account number from the demo dataset", () => {
    const { names, branches } = customerIdentifiers();
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (![".json", ".jsonl", ".txt", ".md"].includes(extname(path))) continue;
        const text = readFileSync(path, "utf8");
        for (const value of [...names, ...branches]) if (text.includes(value)) hits.push(`${path}: ${value}`);
        if (/\b\d{4}-\d{4}\b/.test(text)) hits.push(`${path}: an account number`);
      }
    };
    walk("evidence");
    expect(hits).toEqual([]);
  });
});
