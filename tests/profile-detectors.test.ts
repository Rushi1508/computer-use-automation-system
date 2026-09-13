import { describe, expect, it } from "vitest";

import { findMember } from "../apps/legacy-demo/data.js";
import {
  confirmationPage,
  interstitialPage,
  loginPage,
  memberDetailPage,
  notFoundPage,
  permissionDeniedPage,
  searchPage,
  serverErrorPage,
  sessionExpiredPage,
  subAccountFormPage,
} from "../apps/legacy-demo/views.js";
import { detectorHolds } from "../src/locator/match.js";
import type { Observation } from "../src/perception/types.js";
import { MERIDIAN_PROFILE } from "../src/schema/app-profile.js";

/**
 * A contract test for the application profile.
 *
 * An over-broad detector does not fail loudly. It misclassifies a screen, and
 * because business outcomes are checked before recoverable conditions, a
 * detector that matches too much quietly converts a recoverable interruption
 * into a wrong answer. That happened: "is required" matched the maintenance
 * notice's "No action is required."
 *
 * So every detector in the profile is pinned to exactly the screens it is meant
 * to recognise, and asserted NOT to match any other screen the application can
 * render. Adding a detector without declaring its screens fails this test.
 */

function screen(html: string): Observation {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return { url: "http://app/", title: "", framePaths: [[]], elements: [], tree: text, capturedAt: "", warnings: [] };
}

const member = findMember("12345");
if (member === undefined) throw new Error("fixture member missing");

const SCREENS: Readonly<Record<string, string>> = {
  login: loginPage(),
  loginMissingOperator: loginPage("Operator ID is required."),
  loginBadCredentials: loginPage("Sign-on failed. Check your credentials."),
  search: searchPage(),
  searchMissingMember: searchPage("Member ID is required."),
  searchNonNumeric: searchPage("Member ID must be numeric."),
  notFound: notFoundPage("99999"),
  denied: permissionDeniedPage("55555"),
  detail: memberDetailPage(member),
  form: subAccountFormPage(member),
  formLowDeposit: subAccountFormPage(member, "Initial Deposit must be at least $25.00."),
  formMissingType: subAccountFormPage(member, "Account Type is required."),
  confirmation: confirmationPage(member, "0009-4000", "Savings", 50_000),
  interstitial: interstitialPage("/content"),
  sessionExpired: sessionExpiredPage(),
  applicationError: serverErrorPage("MC-500-test"),
};

/**
 * Screens that carry a message from the application, each of which some
 * detector must claim.
 *
 * The complement of the over-matching rule, and the more expensive mistake. An
 * unclaimed message screen is not a gap in a listing: the run simply carries on
 * looking for the next screen's controls, fails as target_not_found, and with
 * escalation enabled pages a person. That is what happened to a failed sign-on
 * — this file already rendered `loginBadCredentials`, and nothing recognised it.
 *
 * The ordinary screens (login, search, detail, form, confirmation) are absent
 * from this list on purpose: they say nothing, so nothing should match them.
 */
const MESSAGE_SCREENS: readonly string[] = [
  "loginMissingOperator",
  "loginBadCredentials",
  "searchMissingMember",
  "searchNonNumeric",
  "notFound",
  "denied",
  "formLowDeposit",
  "formMissingType",
  "interstitial",
  "sessionExpired",
  "applicationError",
];

/** The screens each detector exists to recognise. Every other screen must not match. */
const RECOGNISES: Readonly<Record<string, readonly string[]>> = {
  SIGN_ON_FAILED: ["loginBadCredentials"],
  MEMBER_NOT_FOUND: ["notFound"],
  PERMISSION_DENIED: ["denied"],
  MEMBER_ID_INVALID: ["searchNonNumeric"],
  VALIDATION_REJECTED: ["formLowDeposit"],
  REQUIRED_FIELD_MISSING: ["loginMissingOperator", "searchMissingMember", "formMissingType"],
  maintenance_interstitial: ["interstitial"],
  session_expired: ["sessionExpired"],
  application_error: ["applicationError"],
};

const DETECTORS = [
  ...MERIDIAN_PROFILE.knownOutcomes.map((o) => ({ id: o.code, detector: o.detector })),
  ...MERIDIAN_PROFILE.recoverables.map((r) => ({ id: r.id, detector: r.detector })),
  ...MERIDIAN_PROFILE.fatalConditions.map((f) => ({ id: f.id, detector: f.detector })),
];

describe("every profile detector matches exactly its own screens", () => {
  it("declares the intended screens for every detector", () => {
    for (const { id } of DETECTORS) expect(RECOGNISES, `no screen contract for ${id}`).toHaveProperty(id);
  });

  it("leaves no message screen unrecognised", () => {
    const claimed = new Set(Object.values(RECOGNISES).flat());
    for (const name of MESSAGE_SCREENS) {
      expect(SCREENS, `unknown screen '${name}'`).toHaveProperty(name);
      expect(claimed.has(name), `screen '${name}' is recognised by no detector, so it would be reported as a failure`).toBe(true);
    }
  });

  for (const { id, detector } of DETECTORS) {
    it(`${id}`, () => {
      const expected = new Set(RECOGNISES[id] ?? []);
      for (const [name, html] of Object.entries(SCREENS)) {
        expect(detectorHolds(detector, screen(html)), `${id} on screen '${name}'`).toBe(expected.has(name));
      }
    });
  }
});
