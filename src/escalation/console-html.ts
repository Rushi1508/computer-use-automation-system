/**
 * The operator console page. Plain by design: a queue, the context a person
 * needs to decide, the live screen, and controls that act on the same session.
 *
 * Every piece of text from the server is inserted with textContent, never
 * innerHTML. Intervention details contain screen text from the application
 * being automated, which is exactly the kind of content that must not be able
 * to inject markup into an operator's console.
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator Console</title>
<style>
  :root { --ink:#1b1f24; --muted:#5b6470; --line:#d6dae0; --bg:#f6f7f9; --panel:#ffffff; --accent:#1f5fbf; --warn:#9a5700; --bad:#b42318; --good:#1e7a3c; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
  header { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:12px 20px; background:var(--panel); border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; }
  .badge { padding:2px 8px; border-radius:10px; font-size:12px; border:1px solid var(--line); }
  .badge.automation { color:var(--good); } .badge.pending_human { color:var(--warn); } .badge.human { color:var(--accent); } .badge.resuming { color:var(--muted); }
  main { display:grid; grid-template-columns:minmax(220px, 300px) 1fr; gap:16px; padding:16px 20px; }
  @media (max-width:760px) { main { grid-template-columns:1fr; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:12px 14px; min-width:0; }
  h2 { font-size:14px; margin:12px 0 8px; } h2:first-child { margin-top:0; }
  ul { list-style:none; margin:0; padding:0; }
  li button { width:100%; text-align:left; background:none; border:1px solid transparent; border-radius:4px; padding:6px; cursor:pointer; font:inherit; color:inherit; }
  li button:hover, li button.selected { border-color:var(--line); background:var(--bg); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 12px; margin:0 0 8px; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg); padding:8px; border-radius:4px; max-height:160px; overflow:auto; margin:0; }
  img.screen { max-width:100%; border:1px solid var(--line); border-radius:4px; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; }
  td, th { border-bottom:1px solid var(--line); padding:4px 6px; text-align:left; vertical-align:top; }
  button.primary { background:var(--accent); color:#fff; border:none; border-radius:4px; padding:6px 12px; cursor:pointer; font:inherit; }
  button.secondary { background:var(--panel); color:inherit; border:1px solid var(--line); border-radius:4px; padding:3px 10px; cursor:pointer; font:inherit; }
  textarea { width:100%; min-height:60px; font:inherit; }
  input { font:inherit; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0; }
  .muted { color:var(--muted); } .error { color:var(--bad); }
</style>
</head>
<body>
<header>
  <h1>Operator Console</h1>
  <span>Session control: <span id="lease" class="badge">loading</span></span>
  <label>Operator <input id="operator" value="operator-1" size="14" autocomplete="off"></label>
  <span id="message" class="error" role="status" aria-live="polite"></span>
</header>
<main>
  <section aria-labelledby="queue-title"><h2 id="queue-title">Interventions</h2><ul id="list"><li class="muted">Nothing yet.</li></ul></section>
  <section id="detail"><p class="muted">When a run needs a person it appears on the left. Claim it to take control of the live session.</p></section>
</main>
<script>
(function () {
  var selected = null;
  var shownStatus = null;
  var screen = null;

  function $(id) { return document.getElementById(id); }

  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      if (k === "onclick") el.onclick = p[k];
      else if (k === "text") el.textContent = p[k];
      else el.setAttribute(k, p[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  try { var saved = localStorage.getItem("operator"); if (saved) $("operator").value = saved; } catch (e) {}
  $("operator").addEventListener("change", function () {
    try { localStorage.setItem("operator", operator()); } catch (e) {}
    if (selected) render(true);
  });

  function operator() { return $("operator").value.trim(); }
  function say(text) { $("message").textContent = text || ""; }

  async function api(path, body) {
    var init = body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ operator: operator() }, body))
    };
    var res = await fetch(path, init);
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function base(id) { return "/api/interventions/" + encodeURIComponent(id); }

  async function tick() {
    try {
      var lease = await api("/api/lease");
      var badge = $("lease");
      badge.className = "badge " + lease.state;
      badge.textContent = lease.state + (lease.holder ? " (" + lease.holder.id + ")" : "");
      var items = await api("/api/interventions");
      var list = $("list");
      list.replaceChildren();
      if (items.length === 0) list.append(h("li", { class: "muted", text: "Nothing yet." }));
      items.forEach(function (item) {
        var button = h("button", { onclick: function () { selected = item.id; screen = null; render(true); } },
          item.id + " · " + item.reason.code, h("br"), h("span", { class: "muted", text: item.status + (item.stepIndex === null ? "" : " · step " + item.stepIndex) }));
        if (item.id === selected) button.className = "selected";
        list.append(h("li", {}, button));
      });
      if (selected) render(false);
    } catch (e) { say(e.message); }
  }

  async function render(force) {
    var i = await api(base(selected));
    if (!force && i.status === shownStatus) return;
    shownStatus = i.status;
    var d = $("detail");
    d.replaceChildren();
    d.append(h("h2", { text: i.id + " — " + i.reason.code + " (" + i.status + ")" }));

    var dl = h("dl");
    function row(label, value) {
      if (value === null || value === undefined || value === "") return;
      dl.append(h("dt", { text: label }), h("dd", { text: String(value) }));
    }
    row("Mode", i.mode);
    row("Capability", i.capabilityId);
    row("Goal", i.goal);
    row("Step", i.stepIndex === null ? null : i.stepIndex + (i.stepIntent ? " — " + i.stepIntent : ""));
    row("Needed", i.expected);
    row("Options", i.allowed.join(", "));
    row("Claimed by", i.claimedBy);
    row("Resolution", i.resolution ? i.resolution.kind : null);
    row("Note", i.note);
    d.append(dl);
    d.append(h("h2", { text: "Why it stopped" }), h("pre", { text: i.reason.detail }));

    if (i.status === "open") {
      d.append(h("div", { class: "row" }, h("button", { class: "primary", onclick: claim }, "Claim and take control")));
    } else if (i.status === "claimed" && i.claimedBy !== operator()) {
      d.append(h("p", { class: "muted", text: "Claimed by " + i.claimedBy + "." }));
    } else if (i.status === "claimed") {
      renderControl(d, i);
    }

    d.append(h("h2", { text: "Live screen" }),
      h("img", { class: "screen", alt: "Screenshot of the live session", src: base(i.id) + "/screenshot?t=" + Date.now() }));

    if (i.actions.length > 0) {
      var body = h("tbody");
      i.actions.forEach(function (a) {
        var t = a.target ? (a.target.name || a.target.anchorText || a.target.role) : (a.action.url || "");
        body.append(h("tr", {}, h("td", { text: a.at.slice(11, 19) }), h("td", { text: a.operator }), h("td", { text: a.action.kind }),
          h("td", { text: t }), h("td", { text: a.ok ? "ok" : ("failed: " + (a.error || "")) })));
      });
      d.append(h("h2", { text: "What the operator did" }), h("div", { class: "scroll" }, h("table", {}, body)));
    }
  }

  function renderControl(d, i) {
    d.append(h("div", { class: "row" },
      h("button", { class: "secondary", onclick: loadScreen }, "Refresh screen and controls"),
      h("span", { class: "muted", text: "You control the session. Automation is paused until you resolve." })));

    if (screen) {
      var body = h("tbody");
      screen.controls.forEach(function (c) {
        var label = c.name || c.anchorText || "(unlabelled)";
        var cell = h("td");
        if (!c.actionable) {
          cell.append(h("button", { class: "secondary", onclick: function () { act({ kind: "read", nodeId: c.nodeId }); } }, "Read"));
        } else if (c.role === "textbox" || c.role === "combobox") {
          var input = h("input", { size: "14", "aria-label": "Value for " + label });
          var kind = c.role === "combobox" ? "select" : "fill";
          cell.append(input, " ", h("button", { class: "secondary", onclick: function () { act({ kind: kind, nodeId: c.nodeId, value: input.value }); } }, kind === "select" ? "Select" : "Fill"));
        } else {
          cell.append(h("button", { class: "secondary", onclick: function () { act({ kind: "click", nodeId: c.nodeId }); } }, "Click"));
        }
        body.append(h("tr", {}, h("td", { text: c.frame }), h("td", { text: c.role }),
          h("td", { text: label + (c.column ? " [" + c.column + "]" : "") }), h("td", { text: c.value === null ? "" : c.value }), cell));
      });
      d.append(h("h2", { text: "Controls on " + screen.title }), h("div", { class: "scroll" }, h("table", {}, body)));
    } else {
      d.append(h("p", { class: "muted", text: "Refresh to list the controls on the live screen." }));
    }

    var note = h("textarea", { id: "note", placeholder: "What you found and what you did" });
    d.append(h("h2", { text: "Hand the session back" }), note);
    var outputs = null;
    if (i.allowed.indexOf("completed_manually") >= 0) {
      outputs = h("input", { size: "40", placeholder: "Outputs you read, e.g. savingsBalance=$1.00" });
      d.append(h("div", { class: "row" }, outputs));
    }
    var buttons = h("div", { class: "row" });
    i.allowed.forEach(function (kind) {
      buttons.append(h("button", { class: kind === "abort" || kind === "reject" ? "secondary" : "primary", onclick: function () { resolve(kind, note.value, outputs ? outputs.value : ""); } }, kind.replace("_", " ")));
    });
    d.append(buttons);
  }

  async function claim() {
    try { await api(base(selected) + "/claim", {}); await loadScreen(); } catch (e) { say(e.message); }
  }

  async function loadScreen() {
    try {
      screen = await api(base(selected) + "/observation?operator=" + encodeURIComponent(operator()));
      say("");
      await render(true);
    } catch (e) { say(e.message); }
  }

  async function act(action) {
    try {
      var result = await api(base(selected) + "/act", { action: action });
      screen = result.screen;
      say(result.ok ? (result.text ? "Read: " + result.text : "") : "Action failed: " + (result.error || "unknown"));
      await render(true);
    } catch (e) { say(e.message); }
  }

  async function resolve(kind, note, outputText) {
    var outputs = {};
    (outputText || "").split(",").forEach(function (pair) {
      var at = pair.indexOf("=");
      if (at > 0) outputs[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    });
    var resolution = Object.keys(outputs).length > 0 ? { kind: kind, outputs: outputs } : { kind: kind };
    try {
      await api(base(selected) + "/resolve", { resolution: resolution, note: note });
      screen = null;
      say("");
      await render(true);
    } catch (e) { say(e.message); }
  }

  tick();
  setInterval(tick, 2000);
})();
</script>
</body>
</html>
`;
