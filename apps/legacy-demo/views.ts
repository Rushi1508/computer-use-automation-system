/**
 * Server-rendered markup for the demo core-banking surface.
 *
 * This is deliberately hostile, in the specific ways the brief describes: a
 * frameset shell, nested tables for layout, generated ASP.NET-style control
 * IDs, presentational attributes, and — most importantly — not a single test
 * ID anywhere. Automation has to find controls the way a human operator's
 * screen reader would.
 *
 * One field is deliberately harder than the rest. "Initial Deposit" on the
 * sub-account form has no <label for>, no aria-label, and no placeholder, so
 * it surfaces in the accessibility tree as a textbox with NO accessible name.
 * Role+name targeting cannot reach it. That is not an oversight — legacy
 * enterprise forms are full of inputs whose only identity is the text in the
 * adjacent table cell, and a locator strategy that cannot handle one will not
 * survive contact with a real core banking screen. It forces the replay
 * engine's anchored-relative fallback to be real rather than theoretical.
 */

import { formatUsd, type Member } from "./data.js";

const AMP = String.fromCharCode(38);
const QUOT = String.fromCharCode(34);
const APOS = String.fromCharCode(39);

export function esc(value: string): string {
  return value
    .split(AMP).join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split(QUOT).join("&quot;")
    .split(APOS).join("&#39;");
}

const CHROME_STYLE = `
  body { font-family: Verdana, Arial, sans-serif; font-size: 11px; margin: 0; background: #d4d0c8; }
  table { border-collapse: collapse; font-size: 11px; }
  .hdr { background: #003366; color: #ffffff; padding: 6px 10px; font-weight: bold; font-size: 12px; }
  .sub { background: #6688aa; color: #ffffff; padding: 3px 10px; font-size: 10px; }
  .pane { background: #ffffff; border: 1px solid #808080; margin: 8px; padding: 10px; }
  .grid td, .grid th { border: 1px solid #a0a0a0; padding: 3px 6px; }
  .grid th { background: #e8e8e8; text-align: left; }
  .err { color: #aa0000; font-weight: bold; }
  input[type=text], input[type=password], select { font-family: Verdana; font-size: 11px; border: 1px solid #7f9db9; }
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><title>${esc(title)}</title><style>${CHROME_STYLE}</style></head>
<body>
<table width="100%" cellspacing="0" cellpadding="0"><tr><td class="hdr">MERIDIAN CORE &#8212; Member Servicing</td></tr>
<tr><td class="sub">${esc(title)}</td></tr></table>
${body}
</body></html>`;
}

// --- Authentication ----------------------------------------------------------

export function loginPage(error?: string): string {
  const banner = error ? `<tr><td colspan="2" class="err">${esc(error)}</td></tr>` : "";
  return shell(
    "Sign On",
    `<div class="pane">
<form method="post" action="/login">
<table cellpadding="4">
${banner}
<tr><td><label for="ctl00_txtOperator">Operator ID</label></td>
    <td><input type="text" id="ctl00_txtOperator" name="operator" size="24"></td></tr>
<tr><td><label for="ctl00_txtPass">Password</label></td>
    <td><input type="password" id="ctl00_txtPass" name="password" size="24"></td></tr>
<tr><td></td><td><input type="submit" value="Sign On"></td></tr>
</table>
</form>
<p style="color:#666">Demo credentials: any non-empty operator ID with password <b>demo</b>.</p>
</div>`,
  );
}

// --- Frameset shell ----------------------------------------------------------

export function framesetPage(): string {
  return `<!DOCTYPE html>
<html><head><title>MERIDIAN CORE</title></head>
<frameset cols="170,*" frameborder="1" border="1">
  <frame src="/nav" name="navmenu" scrolling="no">
  <frame src="/content" name="main">
</frameset>
</html>`;
}

export function navPage(): string {
  return `<!DOCTYPE html>
<html><head><style>${CHROME_STYLE} body{background:#e8e8e8;} a{display:block;padding:4px 8px;color:#003366;}</style></head>
<body>
<div class="sub">Navigation</div>
<a href="/content" target="main">Member Search</a>
<a href="/content" target="main">Account Servicing</a>
<a href="/logout" target="_top">Sign Off</a>
</body></html>`;
}

// --- Search ------------------------------------------------------------------

export function searchPage(error?: string): string {
  const banner = error ? `<tr><td colspan="3" class="err">${esc(error)}</td></tr>` : "";
  return shell(
    "Member Search",
    `<div class="pane">
<form method="post" action="/members/search">
<table cellpadding="4">
${banner}
<tr><td><label for="ctl00_MainContent_txtMemberId">Member ID</label></td>
    <td><input type="text" id="ctl00_MainContent_txtMemberId" name="memberId" size="18" maxlength="10"></td>
    <td><input type="submit" value="Search"></td></tr>
</table>
</form>
<p style="color:#666">Try 12345, 23456, 34567. 55555 is restricted; 67890 is closed.</p>
</div>`,
  );
}

export function notFoundPage(memberId: string): string {
  return shell(
    "Member Search",
    `<div class="pane">
<p class="err">No member found for ID ${esc(memberId)}.</p>
<p>Verify the number and search again.</p>
<form method="get" action="/content"><input type="submit" value="Back to Search"></form>
</div>`,
  );
}

export function permissionDeniedPage(memberId: string): string {
  return shell(
    "Member Search",
    `<div class="pane">
<p class="err">Not authorized to view member ${esc(memberId)}.</p>
<p>This record is restricted. Contact your supervisor for elevated access.</p>
<form method="get" action="/content"><input type="submit" value="Back to Search"></form>
</div>`,
  );
}

// --- Member detail -----------------------------------------------------------

export function memberDetailPage(member: Member): string {
  const rows = member.accounts.length
    ? member.accounts
        .map(
          (a) => `<tr><td>${esc(a.number)}</td><td>${esc(a.type)}</td>
<td align="right">${esc(formatUsd(a.balanceCents))}</td><td>${esc(a.openedOn)}</td></tr>`,
        )
        .join("\n")
    : `<tr><td colspan="4"><i>No open accounts.</i></td></tr>`;

  const action =
    member.status === "active"
      ? `<form method="get" action="/members/${esc(member.id)}/subaccount/new">
<input type="submit" value="Open Sub-Account"></form>`
      : `<p style="color:#666">Account servicing unavailable for ${esc(member.status)} members.</p>`;

  return shell(
    `Member ${member.id}`,
    `<div class="pane">
<table cellpadding="3">
<tr><td><b>Member ID</b></td><td>${esc(member.id)}</td>
    <td><b>Name</b></td><td>${esc(member.name)}</td></tr>
<tr><td><b>Status</b></td><td>${esc(member.status)}</td>
    <td><b>Branch</b></td><td>${esc(member.branch)}</td></tr>
<tr><td><b>Joined</b></td><td>${esc(member.joinedOn)}</td><td></td><td></td></tr>
</table>
<br>
<table class="grid" cellpadding="3">
<tr><th>Account</th><th>Type</th><th>Balance</th><th>Opened</th></tr>
${rows}
</table>
<br>
${action}
<form method="get" action="/content"><input type="submit" value="Back to Search"></form>
</div>`,
  );
}

// --- Sub-account form --------------------------------------------------------

export function subAccountFormPage(member: Member, error?: string): string {
  const banner = error ? `<tr><td colspan="2" class="err">${esc(error)}</td></tr>` : "";
  return shell(
    `Open Sub-Account - ${member.id}`,
    `<div class="pane">
<p>Opening a new sub-account for <b>${esc(member.name)}</b> (${esc(member.id)}).</p>
<form method="post" action="/members/${esc(member.id)}/subaccount">
<table cellpadding="4">
${banner}
<tr><td><label for="ctl00_MainContent_ddlType">Account Type</label></td>
    <td><select id="ctl00_MainContent_ddlType" name="accountType">
      <option value="">-- select --</option>
      <option value="Savings">Savings</option>
      <option value="Money Market">Money Market</option>
      <option value="Certificate">Certificate</option>
    </select></td></tr>
<!-- Deliberately unlabelled: no label element, no aria-label, no placeholder.
     Its only identity is the adjacent cell text, exactly like the legacy
     forms this system exists to automate. -->
<tr><td>Initial Deposit</td>
    <td><input type="text" name="deposit" size="14"></td></tr>
<tr><td><label for="ctl00_MainContent_txtRef">Reference</label></td>
    <td><input type="text" id="ctl00_MainContent_txtRef" name="reference" size="24"></td></tr>
<tr><td></td><td><input type="submit" value="Open Account"></td></tr>
</table>
</form>
</div>`,
  );
}

export function confirmationPage(
  member: Member,
  accountNumber: string,
  accountType: string,
  depositCents: number,
): string {
  return shell(
    "Sub-Account Confirmation",
    `<div class="pane">
<h3 style="font-size:13px;color:#006600;margin:0 0 8px 0">Sub-Account Opened</h3>
<table class="grid" cellpadding="3">
<tr><th>Member</th><td>${esc(member.name)} (${esc(member.id)})</td></tr>
<tr><th>New Account</th><td>${esc(accountNumber)}</td></tr>
<tr><th>Type</th><td>${esc(accountType)}</td></tr>
<tr><th>Initial Deposit</th><td>${esc(formatUsd(depositCents))}</td></tr>
</table>
<br>
<form method="get" action="/content"><input type="submit" value="Back to Search"></form>
</div>`,
  );
}

// --- Runtime fault surfaces --------------------------------------------------

export function interstitialPage(returnTo: string): string {
  return shell(
    "System Notice",
    `<div class="pane">
<p><b>Scheduled maintenance notice</b></p>
<p>Core services will be unavailable Sunday 02:00-04:00 ET. No action is required.</p>
<form method="get" action="${esc(returnTo)}"><input type="submit" value="Continue"></form>
</div>`,
  );
}

export function serverErrorPage(reference: string): string {
  return shell(
    "Application Error",
    `<div class="pane">
<p class="err">Unexpected error processing your request.</p>
<p>Reference: ${esc(reference)}</p>
</div>`,
  );
}

export function sessionExpiredPage(): string {
  return loginPage("Your session has timed out. Please sign on again.");
}
