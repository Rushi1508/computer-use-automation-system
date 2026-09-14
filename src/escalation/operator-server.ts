/**
 * The operator console: an HTTP API over the handoff desk, plus a minimal page.
 *
 * The page is deliberately plain — the brief scopes a real co-browsing console
 * out — but the API behind it is the real control path. A person, the scripted
 * operator in the evidence scenarios, and the tests all drive the live session
 * through these same endpoints, and all of it goes through the lease.
 *
 * Bound to 127.0.0.1 by its callers. There is no operator authentication here:
 * that is a stated cut. In production this sits behind the institution's SSO,
 * and the operator identity comes from the authenticated principal instead of
 * a request field.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import type { Action, Observation } from "../perception/types.js";
import { redactor } from "../policy/redactor.js";
import { LeaseViolation, type SessionLease } from "../session/lease.js";
import { CONSOLE_HTML } from "./console-html.js";
import { DeskError, type HandoffDesk } from "./desk.js";
import { RESOLUTION_KINDS, type Resolution } from "./types.js";

const NodeId = z.number().int().nonnegative();

const ActionBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), nodeId: NodeId }),
  z.object({ kind: z.literal("fill"), nodeId: NodeId, value: z.string() }),
  z.object({ kind: z.literal("select"), nodeId: NodeId, value: z.string() }),
  z.object({ kind: z.literal("read"), nodeId: NodeId }),
  z.object({ kind: z.literal("navigate"), url: z.string() }),
]);

const ResolutionBody = z.object({
  kind: z.enum(RESOLUTION_KINDS),
  outputs: z.record(z.string(), z.string()).optional(),
});

const OperatorId = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, "operator must be a short identifier");

export interface ControlView {
  readonly nodeId: number;
  readonly actionable: boolean;
  readonly role: string;
  readonly name: string;
  readonly anchorText: string | null;
  readonly value: string | null;
  readonly column: string | null;
  readonly frame: string;
}

export interface ScreenView {
  readonly url: string;
  readonly title: string;
  readonly warnings: readonly string[];
  readonly controls: readonly ControlView[];
}

export function screenView(obs: Observation): ScreenView {
  return {
    url: obs.url,
    title: obs.title,
    warnings: obs.warnings,
    controls: obs.elements.map((e) => ({
      nodeId: e.nodeId,
      actionable: e.actionable,
      role: e.role,
      name: e.name,
      anchorText: e.anchorText,
      value: e.hints.inputType === "password" ? (e.value === "" || e.value === null ? "" : "[REDACTED]") : e.value,
      column: e.grid?.columnHeader ?? null,
      frame: e.framePath.length === 0 ? "top" : e.framePath.join("/"),
    })),
  };
}

function operatorOf(req: Request): string {
  const body = req.body as { operator?: unknown } | undefined;
  const raw = body?.operator ?? req.query["operator"];
  const parsed = OperatorId.safeParse(typeof raw === "string" ? raw.trim() : raw);
  if (!parsed.success) throw new DeskError(400, "operator must be a short identifier (letters, digits, . _ -)");
  return parsed.data;
}

function idOf(req: Request): string {
  return String(req.params["id"] ?? "");
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

function reportInternal(error: unknown): void {
  process.stderr.write(`operator console: ${redactor.redactText(error instanceof Error ? error.message : String(error))}\n`);
}

/** Every response body is redacted on the way out, the same boundary rule the evidence bus follows. */
function json(handler: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = await handler(req, res);
      if (!res.headersSent) res.json(redactor.redactDeep(body));
    } catch (error) {
      const status =
        error instanceof DeskError
          ? error.status
          : error instanceof LeaseViolation
            ? 409
            : error instanceof z.ZodError
              ? 400
              : 500;
      // Only errors raised on purpose carry their message to the client.
      // Anything else is an internal failure whose text may name files or
      // internals, so the client gets a fixed sentence and the detail stays on
      // the server's own output.
      const message =
        error instanceof z.ZodError
          ? error.issues.map((i) => i.message).join("; ")
          : status === 500
            ? "internal error in the operator console"
            : error instanceof Error
              ? error.message
              : String(error);
      if (status === 500) reportInternal(error);
      res.status(status).json({ error: redactor.redactText(message) });
    }
  };
}

export function createOperatorApp(desk: HandoffDesk, lease: SessionLease): express.Express {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/", (_req, res) => {
    res.type("html").send(CONSOLE_HTML);
  });

  app.get(
    "/api/lease",
    json(async () => ({ state: lease.state, holder: lease.holder, generation: lease.generation })),
  );

  app.get("/api/interventions", json(async () => desk.list()));

  app.get("/api/interventions/:id", json(async (req) => desk.get(idOf(req))));

  app.get("/api/interventions/:id/screenshot", async (req, res) => {
    try {
      const png = await desk.screenshot(idOf(req));
      res.setHeader("cache-control", "no-store");
      res.type("png").send(png);
    } catch (error) {
      res.status(error instanceof DeskError ? error.status : 500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post(
    "/api/interventions/:id/claim",
    json(async (req) => desk.claim(idOf(req), operatorOf(req))),
  );

  app.get(
    "/api/interventions/:id/observation",
    json(async (req) => screenView(await desk.observe(idOf(req), operatorOf(req)))),
  );

  app.post(
    "/api/interventions/:id/act",
    json(async (req) => {
      const action = ActionBody.parse((req.body as { action?: unknown }).action) as Action;
      const { record, screen } = await desk.act(idOf(req), operatorOf(req), action);
      return {
        ok: record.ok,
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.text === undefined ? {} : { text: record.text }),
        risk: record.policy.verdict,
        screen: screenView(screen),
      };
    }),
  );

  app.post(
    "/api/interventions/:id/resolve",
    json(async (req) => {
      const body = req.body as { resolution?: unknown; note?: unknown };
      const parsed = ResolutionBody.parse(body.resolution);
      const resolution: Resolution =
        parsed.outputs === undefined ? { kind: parsed.kind } : { kind: parsed.kind, outputs: parsed.outputs };
      const note = typeof body.note === "string" ? body.note : "";
      return desk.resolve(idOf(req), operatorOf(req), resolution, note);
    }),
  );

  // Anything that did not match a route gets a JSON 404, not Express's HTML page.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "no such endpoint" });
  });

  // Errors raised before a handler runs, such as a malformed or oversized JSON
  // body, would otherwise reach Express's default handler, which answers with an
  // HTML page containing the stack trace and absolute file paths. The console is
  // an API: it answers in JSON and says only what the caller got wrong.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const failure = error as { status?: unknown; type?: unknown };
    const status =
      typeof failure.status === "number" && failure.status >= 400 && failure.status < 500 ? failure.status : 500;
    const message =
      failure.type === "entity.parse.failed"
        ? "request body is not valid JSON"
        : failure.type === "entity.too.large"
          ? "request body is too large"
          : status < 500
            ? "malformed request"
            : "internal error in the operator console";
    if (status === 500) reportInternal(error);
    res.status(status).json({ error: message });
  });

  return app;
}
