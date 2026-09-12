/**
 * MERIDIAN CORE — a stand-in for the legacy core-banking screens this system
 * exists to automate.
 *
 * It is a proxy target, not a product: server-rendered, frameset-shelled,
 * table-laid-out, and free of test IDs. The brief rules out using a real bank
 * system, and a public demo site would not let us reproduce the runtime
 * conditions that make replay interesting. Owning the target is what makes the
 * error-path evidence deterministic instead of lucky.
 *
 * The flow is search -> detail -> action -> confirmation, which is the shape
 * the brief calls out as non-trivial.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findMember, formatUsd, openSubAccount, resetOpenedAccounts } from "./data.js";
import { armFault, clearFaults, consumeFault, isFaultKind, peekFault, sleep } from "./faults.js";
import {
  confirmationPage,
  framesetPage,
  interstitialPage,
  loginPage,
  memberDetailPage,
  navPage,
  notFoundPage,
  permissionDeniedPage,
  searchPage,
  serverErrorPage,
  sessionExpiredPage,
  subAccountFormPage,
} from "./views.js";

const SESSION_COOKIE = "mcsid";
const MIN_DEPOSIT_CENTS = 25_00;

/** In-memory sessions. Restarting the process signs everyone out, which is fine. */
const sessions = new Map<string, { operator: string; signedInAt: number }>();

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function currentSession(req: Request): { operator: string } | undefined {
  const sid = readCookie(req, SESSION_COOKIE);
  if (sid === undefined) return undefined;
  return sessions.get(sid);
}

function html(res: Response, body: string, status = 200): void {
  res.status(status).type("html").send(body);
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // --- Control plane ---------------------------------------------------------
  // Not part of the automated surface. The agent and the replay engine never
  // touch these; the test harness arms faults here so that recorded artifacts
  // stay free of test scaffolding.

  app.post("/_control/fault", (req, res) => {
    const kind = String(req.body?.kind ?? "");
    if (!isFaultKind(kind)) {
      res.status(400).json({ error: `unknown fault kind: ${kind}` });
      return;
    }
    const armed = armFault({
      kind,
      pathPrefix: String(req.body?.pathPrefix ?? ""),
      times: Number(req.body?.times ?? 1),
      delayMs: Number(req.body?.delayMs ?? 6000),
    });
    res.json({ armed });
  });

  app.post("/_control/reset", (_req, res) => {
    clearFaults();
    resetOpenedAccounts();
    sessions.clear();
    res.json({ ok: true });
  });

  app.get("/_control/state", (_req, res) => {
    res.json({ armedFault: peekFault(), sessions: sessions.size });
  });

  // --- Fault middleware ------------------------------------------------------

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/_control")) return next();

    const fault = consumeFault(req.path);
    if (fault === null) return next();

    switch (fault.kind) {
      case "slow_load":
        // Transient slowness. The request still succeeds — a replay engine with
        // a sane wait strategy should absorb this rather than fail.
        void sleep(fault.delayMs).then(next);
        return;

      case "interstitial": {
        // An unexpected-but-known dialog. Recoverable: dismiss and continue.
        // Restricted to GET so the Continue button has somewhere sane to return.
        if (req.method !== "GET") return next();
        html(res, interstitialPage(req.originalUrl));
        return;
      }

      case "session_expired": {
        const sid = readCookie(req, SESSION_COOKIE);
        if (sid !== undefined) sessions.delete(sid);
        html(res, sessionExpiredPage(), 200);
        return;
      }

      case "server_error":
        html(res, serverErrorPage(`MC-500-${randomUUID().slice(0, 8)}`), 500);
        return;
    }
  });

  // --- Authentication --------------------------------------------------------

  app.get("/", (req, res) => {
    if (currentSession(req) === undefined) {
      html(res, loginPage());
      return;
    }
    html(res, framesetPage());
  });

  app.post("/login", (req, res) => {
    const operator = String(req.body?.operator ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (operator === "") {
      html(res, loginPage("Operator ID is required."), 200);
      return;
    }
    if (password !== "demo") {
      html(res, loginPage("Sign-on failed. Check your credentials."), 200);
      return;
    }

    const sid = randomUUID();
    sessions.set(sid, { operator, signedInAt: Date.now() });
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect(302, "/");
  });

  app.get("/logout", (req, res) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid !== undefined) sessions.delete(sid);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    res.redirect(302, "/");
  });

  // --- Authenticated surface -------------------------------------------------

  const requireSession = (req: Request, res: Response, next: NextFunction): void => {
    if (currentSession(req) === undefined) {
      html(res, sessionExpiredPage());
      return;
    }
    next();
  };

  app.get("/nav", requireSession, (_req, res) => html(res, navPage()));

  app.get("/content", requireSession, (_req, res) => html(res, searchPage()));

  app.post("/members/search", requireSession, (req, res) => {
    const raw = String(req.body?.memberId ?? "").trim();

    if (raw === "") {
      html(res, searchPage("Member ID is required."));
      return;
    }
    if (!/^\d{1,10}$/.test(raw)) {
      html(res, searchPage("Member ID must be numeric."));
      return;
    }

    const member = findMember(raw);

    // Business outcome, not a failure: the caller needs to know the member does
    // not exist, and that is a legitimate answer rather than a crash.
    if (member === undefined) {
      html(res, notFoundPage(raw));
      return;
    }

    // Business outcome: the record exists but this operator cannot see it.
    if (member.status === "restricted") {
      html(res, permissionDeniedPage(raw));
      return;
    }

    html(res, memberDetailPage(member));
  });

  app.get("/members/:id", requireSession, (req, res) => {
    const member = findMember(String(req.params.id));
    if (member === undefined) {
      html(res, notFoundPage(String(req.params.id)));
      return;
    }
    if (member.status === "restricted") {
      html(res, permissionDeniedPage(String(req.params.id)));
      return;
    }
    html(res, memberDetailPage(member));
  });

  app.get("/members/:id/subaccount/new", requireSession, (req, res) => {
    const member = findMember(String(req.params.id));
    if (member === undefined || member.status !== "active") {
      html(res, notFoundPage(String(req.params.id)));
      return;
    }
    html(res, subAccountFormPage(member));
  });

  app.post("/members/:id/subaccount", requireSession, (req, res) => {
    const member = findMember(String(req.params.id));
    if (member === undefined || member.status !== "active") {
      html(res, notFoundPage(String(req.params.id)));
      return;
    }

    const accountType = String(req.body?.accountType ?? "").trim();
    const depositRaw = String(req.body?.deposit ?? "").trim();

    if (accountType === "") {
      html(res, subAccountFormPage(member, "Account Type is required."));
      return;
    }

    const normalized = depositRaw.replace(/[$,]/g, "");
    if (normalized === "" || !/^\d+(\.\d{1,2})?$/.test(normalized)) {
      html(res, subAccountFormPage(member, "Initial Deposit must be a dollar amount."));
      return;
    }

    const depositCents = Math.round(Number(normalized) * 100);
    if (depositCents < MIN_DEPOSIT_CENTS) {
      html(
        res,
        subAccountFormPage(
          member,
          `Initial Deposit must be at least ${formatUsd(MIN_DEPOSIT_CENTS)}.`,
        ),
      );
      return;
    }

    const accountNumber = openSubAccount(member.id, accountType, depositCents);
    html(res, confirmationPage(member, accountNumber, accountType, depositCents));
  });

  app.use((_req, res) => {
    html(res, serverErrorPage("MC-404-NOTFOUND"), 404);
  });

  return app;
}

/**
 * Only listen when this file is the process entry point. Comparing the resolved
 * argv path against this module's own path is the check that actually holds:
 * matching on the filename alone is true for any importer, so the test suite
 * would silently bind the demo port on import.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const port = Number(process.env["DEMO_APP_PORT"] ?? 4173);
  createApp().listen(port, "127.0.0.1", () => {
    process.stdout.write(`MERIDIAN CORE demo listening on http://127.0.0.1:${port}\n`);
  });
}
