import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Guards the one toolchain assumption the capability catalog depends on:
 * a single Zod schema must serve as both the runtime validator for an artifact
 * and the JSON Schema an agent uses to call it. If zod's JSON Schema emitter
 * changes shape, the catalog's tool definitions break silently — catch it here.
 */
describe("zod drives both validation and the agent-facing contract", () => {
  const MemberLookupInput = z.object({
    memberId: z.string().describe("The member's account identifier"),
  });

  it("validates at runtime", () => {
    expect(MemberLookupInput.parse({ memberId: "12345" })).toEqual({ memberId: "12345" });
    expect(MemberLookupInput.safeParse({ memberId: 12345 }).success).toBe(false);
  });

  it("emits a JSON Schema usable as a tool input_schema", () => {
    const schema = z.toJSONSchema(MemberLookupInput);
    expect(schema).toMatchObject({
      type: "object",
      properties: { memberId: { type: "string" } },
      required: ["memberId"],
    });
  });
});
