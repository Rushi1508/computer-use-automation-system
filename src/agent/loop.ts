/**
 * The discovery loop: observe -> decide -> act, with a model in the decision
 * seat and the policy engine between it and the surface.
 *
 * A manual loop rather than the SDK's tool runner. The runner would handle the
 * mechanics, but three things here are not incidental: the trace this loop
 * emits is the authoritative input to the artifact compiler, budgets are
 * enforced against wall-clock as well as step count, and a policy verdict has
 * to be able to turn into a tool_result the model reads and reasons about
 * rather than an exception. Owning the loop keeps that data flow explicit, and
 * keeps a beta dependency out of the one component whose output everything
 * downstream is compiled from.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { Action, ObservedElement, Surface } from "../perception/types.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { PolicyDecision } from "../policy/types.js";
import type { EvidenceBus } from "../evidence/bus.js";
import { locatorEvidence, type LocatorEvidence, verifiableText } from "../locator/match.js";
import { type ConfirmHandler, denyByDefault } from "../policy/confirm.js";
import { CostAccountant } from "./cost.js";
import { renderObservation, SYSTEM_PROMPT, toolDefinitions, TOOL_SCHEMAS, type ToolName } from "./tools.js";

export interface TraceStep {
  readonly index: number;
  readonly intent: string;
  readonly action: Action;
  /** Full snapshot of the targeted control, so the compiler can derive locators. */
  readonly target?: ObservedElement;
  /**
   * How many elements each candidate strategy matched on the screen at the
   * moment of acting. The compiler ranks locators from this; without it,
   * uniqueness could only be judged against other recorded targets, which is
   * how an ambiguous target was once rated unique.
   */
  readonly locatorEvidence?: readonly LocatorEvidence[];
  readonly urlBefore: string;
  readonly titleBefore: string;
  readonly urlAfter: string;
  readonly policy: PolicyDecision;
  readonly ok: boolean;
  readonly error?: string;
  readonly outputName?: string;
  readonly extracted?: string;
  readonly at: string;
}

export type DiscoveryStatus = "succeeded" | "escalated" | "budget_exhausted" | "failed";

export interface DiscoveryResult {
  readonly status: DiscoveryStatus;
  readonly summary: string;
  readonly goal: string;
  readonly entrypoint: string;
  readonly trace: readonly TraceStep[];
  readonly checkpoints: readonly {
    readonly afterStep: number;
    readonly description: string;
    /** Stable on-screen label confirmed when the checkpoint was recorded, or null. */
    readonly verifiedText: string | null;
  }[];
  readonly outputs: Readonly<Record<string, string>>;
  readonly steps: number;
  readonly elapsedMs: number;
  readonly usage: { readonly turns: number; readonly costUsd: number; readonly cacheWorking: boolean };
}

// The confirmation seam lives with the policy engine, because replay needs it
// too and the production path must not depend on the model-driven agent.
// Re-exported for existing callers.
export { type ConfirmHandler, autoApprove, denyByDefault } from "../policy/confirm.js";

export interface DiscoveryOptions {
  readonly goal: string;
  readonly entrypoint: string;
  readonly surface: Surface;
  readonly policy: PolicyEngine;
  readonly evidence: EvidenceBus;
  readonly maxSteps?: number;
  readonly maxMs?: number;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly onConfirm?: ConfirmHandler;
  /** Hard ceiling on estimated model spend, in USD. The loop stops when reached. */
  readonly maxCostUsd?: number;
}

/**
 * Builds a client that works with an API key or a gateway auth token.
 * Sending both makes the API reject the request, so exactly one is chosen.
 */
export function createClient(): Anthropic {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const authToken = process.env["ANTHROPIC_AUTH_TOKEN"];
  const baseURL = process.env["ANTHROPIC_BASE_URL"];

  const options: ConstructorParameters<typeof Anthropic>[0] = {};
  if (baseURL !== undefined && baseURL !== "") options.baseURL = baseURL;
  if (apiKey !== undefined && apiKey !== "") options.apiKey = apiKey;
  else if (authToken !== undefined && authToken !== "") options.authToken = authToken;
  else {
    throw new Error(
      "No credentials found. Set ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN with ANTHROPIC_BASE_URL.",
    );
  }
  return new Anthropic(options);
}

/** Maps a validated tool call onto a runtime Action. */
function toAction(name: ToolName, input: Record<string, unknown>): Action | null {
  switch (name) {
    case "click":
      return { kind: "click", nodeId: input["nodeId"] as number };
    case "fill":
      return { kind: "fill", nodeId: input["nodeId"] as number, value: input["value"] as string };
    case "select":
      return { kind: "select", nodeId: input["nodeId"] as number, value: input["value"] as string };
    case "navigate":
      return { kind: "navigate", url: input["url"] as string };
    case "read":
      return { kind: "read", nodeId: input["nodeId"] as number };
    default:
      return null;
  }
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const {
    goal,
    entrypoint,
    surface,
    policy,
    evidence,
    maxSteps = 30,
    maxMs = 5 * 60_000,
    model = process.env["ANTHROPIC_MODEL"] ?? "claude-opus-5",
    effort = (process.env["ANTHROPIC_EFFORT"] as DiscoveryOptions["effort"]) ?? "high",
    onConfirm = denyByDefault,
    maxCostUsd = Number(process.env["MAX_RUN_COST_USD"] ?? 0.75),
  } = options;

  const client = createClient();
  const accountant = new CostAccountant(model);
  const startedAt = Date.now();
  const trace: TraceStep[] = [];
  const checkpoints: { afterStep: number; description: string; verifiedText: string | null }[] = [];
  const outputs: Record<string, string> = {};

  evidence.emit("run.start", `Discovery run started`, { goal, entrypoint, model, effort, maxSteps, maxMs });

  // The entrypoint navigation is itself gated — the allowlist applies to the
  // very first action, not only to what the model chooses afterwards.
  const entryDecision = policy.checkLocation(entrypoint);
  evidence.emit("policy.decision", `Entrypoint ${entryDecision.verdict}`, entryDecision);
  if (entryDecision.verdict !== "allow") {
    const result: DiscoveryResult = {
      status: "failed",
      summary: `Entrypoint refused by policy: ${entryDecision.reason}`,
      goal,
      entrypoint,
      trace,
      checkpoints,
      outputs,
      steps: 0,
      elapsedMs: Date.now() - startedAt,
      usage: { turns: 0, costUsd: 0, cacheWorking: false },
    };
    evidence.writeResult(result);
    return result;
  }

  await surface.act({ kind: "navigate", url: entrypoint });
  let observation = await surface.observe();
  evidence.emit("observation", `Observed ${observation.elements.length} controls`, {
    url: observation.url,
    title: observation.title,
  });

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `GOAL: ${goal}\n\nHere is the current screen.\n\n${renderObservation(observation)}`,
    },
  ];

  let status: DiscoveryStatus = "budget_exhausted";
  let summary = "Step or time budget exhausted before the goal was reached.";
  let stepIndex = 0;
  let finished = false;

  while (!finished) {
    if (stepIndex >= maxSteps) {
      summary = `Step budget of ${maxSteps} exhausted.`;
      break;
    }
    if (Date.now() - startedAt > maxMs) {
      status = "budget_exhausted";
      summary = `Time budget of ${maxMs}ms exhausted.`;
      break;
    }

    if (accountant.costUsd >= maxCostUsd) {
      status = "budget_exhausted";
      summary = `Spend ceiling of $${maxCostUsd.toFixed(2)} reached (${accountant.summary()}).`;
      evidence.emit("run.end", summary, accountant.totals);
      break;
    }

    const response = await client.messages.create({
      model,
      max_tokens: 8_000,
      // Cache breakpoint on the system block. Tools render before system, so
      // this one marker caches the tool definitions and the system prompt
      // together — the stable prefix that would otherwise be re-billed in full
      // on every turn of the loop.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      // Auto-placed breakpoint on the last cacheable block, so the growing
      // conversation history is cached incrementally as well.
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive" },
      output_config: { effort },
      tools: toolDefinitions(),
      messages,
    });

    accountant.add(response.usage);
    evidence.emit("model.decision", `Turn ${accountant.totals.turns}`, {
      stopReason: response.stop_reason,
      usage: response.usage,
      runningCostUsd: Number(accountant.costUsd.toFixed(5)),
    });

    if (response.stop_reason === "refusal") {
      status = "failed";
      summary = "The model declined the request.";
      evidence.emit("error", summary, { stopDetails: response.stop_details });
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // No action and no terminal call. Nudge once rather than looping forever.
      messages.push({
        role: "user",
        content: "You did not take an action. Take the next action, or call done or escalate.",
      });
      stepIndex++;
      continue;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      const name = use.name as ToolName;
      const schema = TOOL_SCHEMAS[name];
      if (schema === undefined) {
        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: `Unknown tool ${name}`, is_error: true });
        continue;
      }

      const parsed = schema.safeParse(use.input);
      if (!parsed.success) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Invalid arguments: ${parsed.error.message}`,
          is_error: true,
        });
        continue;
      }
      const input = parsed.data as Record<string, unknown>;

      // --- Terminal and annotation tools -----------------------------------

      if (name === "done") {
        status = "succeeded";
        summary = String(input["summary"]);
        evidence.emit("run.end", `Model reported success`, { summary });
        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: "Recorded." });
        finished = true;
        continue;
      }

      if (name === "escalate") {
        status = "escalated";
        summary = String(input["reason"]);
        evidence.emit("escalation", `Model escalated`, { reason: summary });
        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: "Escalation recorded." });
        finished = true;
        continue;
      }

      if (name === "checkpoint") {
        const description = String(input["description"]);
        // A checkpoint is only useful later if replay can assert it, so it is
        // resolved now, while the screen it describes is still showing. Keep a
        // stable on-screen label that contains no value this run typed. Prose
        // about "member 12345" would either fail on replay or copy this run's
        // data into the capability.
        const typed = trace.flatMap((s) =>
          s.action.kind === "fill" || s.action.kind === "select" ? [s.action.value] : [],
        );
        const verifiedText = verifiableText(description, observation, typed);
        checkpoints.push({ afterStep: trace.length - 1, description, verifiedText });
        evidence.emit("checkpoint", description, { afterStep: trace.length - 1, verifiedText });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content:
            verifiedText !== null
              ? `Checkpoint recorded and verified on screen: "${verifiedText}".`
              : "Checkpoint recorded, but none of its text could be verified as a stable on-screen label, so " +
                "replay cannot assert it. If it matters, record another checkpoint quoting exact visible text " +
                "such as a heading, column header or button label.",
        });
        continue;
      }

      // --- Acting tools -----------------------------------------------------

      const action = toAction(name, input);
      if (action === null) {
        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: `Unsupported tool ${name}`, is_error: true });
        continue;
      }

      const target =
        "nodeId" in action
          ? observation.elements.find((e) => e.nodeId === action.nodeId)
          : undefined;

      if ("nodeId" in action && target === undefined) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `No control with node id ${action.nodeId} in the current observation. Re-read CONTROLS and use a current id.`,
          is_error: true,
        });
        continue;
      }

      const decision = policy.check(action, { mode: "discovery" }, target);
      evidence.emit("policy.decision", `${action.kind}: ${decision.verdict}`, {
        rule: decision.rule,
        reason: decision.reason,
        target: target === undefined ? undefined : { role: target.role, name: target.name },
      });

      let permitted = decision.verdict === "allow";
      if (decision.verdict === "confirm") {
        permitted = await onConfirm(decision, action, target);
        evidence.emit("policy.decision", `Confirmation ${permitted ? "granted" : "refused"}`, {
          rule: decision.rule,
        });
      }

      if (!permitted) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Refused by policy (${decision.rule}): ${decision.reason} Do not attempt an alternative route to this action.`,
          is_error: true,
        });
        continue;
      }

      const urlBefore = observation.url;
      const titleBefore = observation.title;
      // Measured against the screen as it is before acting — the screen the
      // model chose this element from.
      const evidenceForTarget =
        target === undefined ? undefined : locatorEvidence(target, observation.elements);
      const why = typeof input["why"] === "string" ? input["why"] : "(no intent recorded)";

      evidence.emit("action.start", `${action.kind}`, { intent: why, action });
      const result = await surface.act(action);

      // A click can land somewhere the allowlist forbids. Checking intent alone
      // would miss it, so the location is re-checked after the fact.
      let postDecision: PolicyDecision | null = null;
      if (result.ok) {
        const after = await surface.observe();
        postDecision = policy.checkLocation(after.url);
        observation = after;
      }

      const step: TraceStep = {
        index: stepIndex,
        intent: why,
        action,
        ...(target === undefined ? {} : { target }),
        ...(evidenceForTarget === undefined ? {} : { locatorEvidence: evidenceForTarget }),
        urlBefore,
        titleBefore,
        urlAfter: observation.url,
        policy: decision,
        ok: result.ok && (postDecision === null || postDecision.verdict === "allow"),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(name === "read" ? { outputName: String(input["outputName"]) } : {}),
        ...(result.text === undefined ? {} : { extracted: result.text }),
        at: new Date().toISOString(),
      };
      trace.push(step);
      stepIndex++;

      if (name === "read" && result.ok && result.text !== undefined) {
        outputs[String(input["outputName"])] = result.text;
        evidence.emit("extraction", `Read ${String(input["outputName"])}`, { value: result.text });
      }

      evidence.emit("action.result", `${action.kind} ${result.ok ? "ok" : "failed"}`, {
        ok: result.ok,
        error: result.error,
        url: observation.url,
      });

      if (postDecision !== null && postDecision.verdict !== "allow") {
        status = "failed";
        summary = `Action navigated outside the allowlist: ${postDecision.reason}`;
        evidence.emit("error", summary, postDecision);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Blocked: that landed outside the permitted area. ${postDecision.reason}`,
          is_error: true,
        });
        finished = true;
        continue;
      }

      if (!result.ok) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Action failed: ${result.error ?? "unknown error"}\n\n${renderObservation(observation)}`,
          is_error: true,
        });
        continue;
      }

      const readNote =
        name === "read" ? `Read "${result.text ?? ""}" as output ${String(input["outputName"])}.\n\n` : "";
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: `${readNote}${renderObservation(observation)}`,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  const result: DiscoveryResult = {
    status,
    summary,
    goal,
    entrypoint,
    trace,
    checkpoints,
    outputs,
    steps: trace.length,
    elapsedMs: Date.now() - startedAt,
    usage: {
      turns: accountant.totals.turns,
      costUsd: Number(accountant.costUsd.toFixed(5)),
      cacheWorking: accountant.cacheIsWorking,
    },
  };

  if (status !== "succeeded") {
    const png = await surface.screenshot().catch(() => null);
    if (png !== null) evidence.saveScreenshot("final-state", png);
    evidence.saveSnapshot("final-tree", observation.tree);
  }

  evidence.emit("run.end", `Discovery ${status} | ${accountant.summary()}`, {
    status,
    steps: trace.length,
    outputs,
    usage: accountant.totals,
    costUsd: Number(accountant.costUsd.toFixed(5)),
  });
  evidence.writeResult(result);
  return result;
}
