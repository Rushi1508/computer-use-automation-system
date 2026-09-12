/**
 * A Surface backed by Playwright, driven through the accessibility tree.
 *
 * Why the accessibility tree rather than the DOM: it is the one perception
 * channel that exists on modern web, legacy web, and desktop alike. Windows
 * exposes UI Automation and macOS exposes AX with the same core concepts —
 * role, name, value — so a desktop driver implements this same interface with
 * a different backend rather than forcing a second architecture. The DOM has
 * no desktop analogue, and screenshot coordinates have no stable identity
 * across window sizes or themes.
 *
 * Two implementation notes that matter for correctness:
 *
 * 1. Handles and metadata are gathered with the SAME selector against the same
 *    document, so `$$` and `$$eval` return elements in identical order and can
 *    be zipped by index. Computing them separately with different selectors
 *    would silently misalign nodeIds with the elements they name — the kind of
 *    bug that produces an agent clicking the wrong control with no error.
 *
 * 2. Nothing here mutates the page. Tagging elements with a temporary
 *    attribute would be an easier way to address them, but it would pollute
 *    DOM snapshots captured as evidence and could perturb an application that
 *    watches its own DOM. Observation must be side-effect free.
 */

import { chromium, type Browser, type ElementHandle, type Frame, type Page } from "playwright";

import {
  type Action,
  type ActResult,
  type FramePath,
  type Observation,
  type ObservedElement,
  type Surface,
  SurfaceError,
} from "./types.js";

/**
 * Elements worth offering to the model. Deliberately narrow: an Observation
 * listing every <td> would bury the handful of controls that can actually be
 * operated, and the skill listing budget is not the only place where noise
 * costs accuracy.
 */
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=combobox]",
  "[role=checkbox]",
  "[role=radio]",
].join(", ");

/**
 * Cells that may carry a value worth returning. Legacy screens put almost all
 * of their information here rather than in controls, so an observation without
 * them cannot address the data a capability exists to extract.
 */
const READABLE_SELECTOR = "td, th, [role=cell], [role=rowheader], [role=columnheader]";

/** Ceiling per frame, so a large grid cannot crowd out the actionable controls. */
const MAX_READABLE_PER_FRAME = 40;

/** Serialized into the page. Must be self-contained — no closure over module scope. */
interface RawReadable {
  /**
   * Whether this cell is worth offering. The array must stay index-aligned with
   * the element handles gathered by the same selector, so unwanted entries are
   * flagged rather than dropped — filtering in the page would silently shift
   * every later index and pair node ids with the wrong cells.
   */
  keep: boolean;
  text: string;
  anchorText: string | null;
  tag: string;
  columnHeader: string | null;
  rowTexts: string[];
}

/** Serialized into the page. Must be self-contained — no closure over module scope. */
interface RawElementMeta {
  role: string;
  name: string;
  value: string | null;
  enabled: boolean;
  visible: boolean;
  anchorText: string | null;
  tag: string;
  inputType: string | null;
  domId: string | null;
  fieldName: string | null;
}

/**
 * Computes role, accessible name, and anchor text for each matched element.
 *
 * This is an approximation of the full ARIA accessible-name algorithm, covering
 * the cases interactive controls actually hit: aria-labelledby, aria-label, an
 * associated label element, a submit button's value, and element text. It
 * deliberately does NOT invent a name when none of those apply — returning ""
 * for an unlabelled input is the correct and load-bearing answer, because it
 * tells the compiler that name-based targeting is unavailable for that control
 * and an anchored strategy must carry it.
 *
 * SERIALIZATION CONSTRAINT — read before editing.
 *
 * This function is stringified and executed inside the browser, which has none
 * of this module's scope. It must therefore contain no named inner functions:
 * esbuild (via tsx) rewrites `const helper = () => {}` into
 * `const helper = __name(() => {}, "helper")` to preserve function names, and
 * `__name` does not exist in the page, so the whole evaluate throws
 * ReferenceError. The failure is environment-dependent — vitest transforms with
 * different settings, so a test suite will happily pass while the real CLI path
 * observes an entirely blank screen.
 *
 * Everything below is therefore written with anonymous inline expressions only.
 * `assertSerializable` enforces this at startup so a future edit fails loudly
 * instead of silently reporting an empty page.
 */
function collectMeta(selector: string): RawElementMeta[] {
  return Array.from(document.querySelectorAll(selector)).map((el) => {
    const tag = el.tagName.toLowerCase();
    const inputType = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : null;
    const input = el as HTMLInputElement;

    const role = (() => {
      const explicit = el.getAttribute("role");
      if (explicit !== null && explicit !== "") return explicit;
      if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        if (inputType === "submit" || inputType === "button" || inputType === "reset" || inputType === "image") {
          return "button";
        }
        if (inputType === "checkbox") return "checkbox";
        if (inputType === "radio") return "radio";
        return "textbox";
      }
      return "generic";
    })();

    const name = (() => {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy !== null && labelledBy !== "") {
        const parts: string[] = [];
        for (const id of labelledBy.split(/\s+/)) {
          const t = (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " ").trim();
          if (t !== "") parts.push(t);
        }
        if (parts.length > 0) return parts.join(" ");
      }

      const ariaLabel = (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
      if (ariaLabel !== "") return ariaLabel;

      const labels = input.labels;
      if (labels !== undefined && labels !== null && labels.length > 0) {
        const parts: string[] = [];
        for (const label of Array.from(labels)) {
          const t = (label.textContent ?? "").replace(/\s+/g, " ").trim();
          if (t !== "") parts.push(t);
        }
        if (parts.length > 0) return parts.join(" ");
      }

      if (tag === "input" && (inputType === "submit" || inputType === "button" || inputType === "reset")) {
        if (input.value !== "") return input.value;
      }
      if (tag === "button" || tag === "a") {
        const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t !== "") return t;
      }

      const title = (el.getAttribute("title") ?? "").replace(/\s+/g, " ").trim();
      if (title !== "") return title;

      // No accessible name. This is a real answer, not a failure.
      return "";
    })();

    const anchorText = (() => {
      // The cell immediately left of the control's own cell is its label in
      // almost every legacy form layout; the first cell of the row is only a
      // good guess when there is nothing to the left.
      const ownCell = el.closest("td, th");
      const leftCell = ownCell?.previousElementSibling ?? null;
      if (leftCell !== null) {
        const t = (leftCell.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t !== "") return t;
      }
      const row = el.closest("tr");
      if (row !== null) {
        for (const cell of Array.from(row.children)) {
          if (cell.contains(el)) continue;
          const t = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
          if (t !== "") return t;
        }
      }
      const prev = el.previousElementSibling;
      if (prev !== null) {
        const t = (prev.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t !== "") return t;
      }
      return null;
    })();

    return {
      role,
      name,
      value: tag === "input" || tag === "select" || tag === "textarea" ? (input.value ?? null) : null,
      enabled: !(input.disabled ?? false),
      visible: el.getClientRects().length > 0,
      anchorText,
      tag,
      inputType: tag === "input" ? (el.getAttribute("type") ?? "text") : null,
      domId: el.getAttribute("id"),
      fieldName: el.getAttribute("name"),
    };
  });
}

/**
 * Collects static text worth reading, with the label that identifies it.
 *
 * Subject to the same SERIALIZATION CONSTRAINT as collectMeta: anonymous inline
 * expressions only, no named inner functions.
 *
 * Cells containing a control are skipped — those are already addressable as
 * actionable elements, and listing them twice would give the model two node ids
 * for one thing. Cells with no anchor are skipped too: a value nobody can name
 * is not a value a capability can return.
 */
function collectReadable(selector: string): RawReadable[] {
  return Array.from(document.querySelectorAll(selector)).map((el) => {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const tag = el.tagName.toLowerCase();

    // Label/value rows in legacy screens run "Label | Value | Label | Value",
    // so the cell immediately to the left is the label far more often than the
    // first cell of the row is. Fall back to the first cell only when there is
    // no preceding one.
    const anchorText = (() => {
      const prev = el.previousElementSibling;
      if (prev !== null) {
        const t = (prev.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t !== "" && t !== text) return t;
      }
      const row = el.closest("tr");
      if (row !== null) {
        for (const cell of Array.from(row.children)) {
          if (cell === el) continue;
          const t = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
          if (t !== "" && t !== text) return t;
        }
      }
      return null;
    })();

    // Grid coordinates. The column header comes from the table's first row,
    // only when that row is made of header cells and is not this cell's own
    // row. colspan is not accounted for — a known limitation that fails safe:
    // a misaligned header produces a locator that matches nothing, which replay
    // reports, rather than one that matches the wrong cell.
    const row = el.closest("tr");
    const table = el.closest("table");
    const headerRow = table === null ? null : table.querySelector("tr");
    const columnHeader = (() => {
      if (row === null || headerRow === null || headerRow === row) return null;
      if (headerRow.querySelector("th") === null) return null;
      const index = Array.from(row.children).indexOf(el);
      const header = index < 0 ? undefined : headerRow.children[index];
      if (header === undefined) return null;
      const t = (header.textContent ?? "").replace(/\s+/g, " ").trim();
      return t === "" ? null : t;
    })();
    const rowTexts: string[] = [];
    if (row !== null) {
      for (const cell of Array.from(row.children)) {
        if (cell === el) continue;
        const t = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t !== "" && t.length <= 200) rowTexts.push(t);
      }
    }

    const keep =
      el.querySelector("input, select, textarea, button, a[href]") === null &&
      el.getClientRects().length > 0 &&
      text !== "" &&
      text.length <= 200 &&
      anchorText !== null;

    return { keep, text, anchorText, tag, columnHeader, rowTexts };
  });
}

/**
 * Guards the serialization constraint above.
 *
 * Checked once at module load: if a build tool has injected helper references
 * into the function body, fail immediately with an actionable message rather
 * than letting every observation come back empty.
 */
function assertSerializable(): void {
  const source = collectMeta.toString() + collectReadable.toString();
  const helpers = ["__name", "__publicField", "__decorateClass", "__toESM", "__commonJS"];
  for (const helper of helpers) {
    if (source.includes(helper)) {
      throw new Error(
        `An in-page function contains the bundler helper '${helper}' and cannot run in the page. ` +
          `Rewrite any named inner function as an anonymous inline expression — see the ` +
          `SERIALIZATION CONSTRAINT note on collectMeta in src/perception/web-playwright.ts.`,
      );
    }
  }
}

assertSerializable();

/**
 * Exposes the exact source strings that get shipped into the page, so a test
 * can assert on what the browser will actually receive rather than on what the
 * source file looks like before transformation.
 */
export function __inPageSources(): string[] {
  return [collectMeta.toString(), collectReadable.toString()];
}

/**
 * Stable identity for a frame within the page.
 *
 * Runs in Node, not the page, so the serialization constraint above does not
 * apply here. The top document contributes no path segment, so its path is [].
 */
function framePathOf(frame: Frame): FramePath {
  const path: string[] = [];
  let current: Frame | null = frame;
  while (current !== null) {
    const parent: Frame | null = current.parentFrame();
    if (parent === null) break;
    const name = current.name();
    path.unshift(name !== "" ? name : `frame@${current.url()}`);
    current = parent;
  }
  return path;
}

/** First line of an error, for a warning that has to stay readable in a log. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

function samePath(a: FramePath, b: FramePath): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

export class PlaywrightWebSurface implements Surface {
  #handles: Array<{ element: ObservedElement; handle: ElementHandle<SVGElement | HTMLElement> }> = [];

  constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly settleMs = 250,
  ) {}

  async observe(): Promise<Observation> {
    await this.#disposeHandles();

    const frames = this.page.frames();
    const elements: ObservedElement[] = [];
    const framePaths: FramePath[] = [];
    const treeParts: string[] = [];
    const warnings: string[] = [];
    let nodeId = 0;

    for (const frame of frames) {
      if (frame.isDetached()) continue;
      const path = framePathOf(frame);

      let handles: Array<ElementHandle<SVGElement | HTMLElement>>;
      let metas: RawElementMeta[];
      try {
        // Same selector, same document, same order — safe to zip by index.
        handles = await frame.$$(INTERACTIVE_SELECTOR);
        metas = await frame.evaluate(collectMeta, INTERACTIVE_SELECTOR);
      } catch (error) {
        // A frame can navigate out from under us mid-observation, but an
        // evaluate that always fails would otherwise look identical to an
        // empty page. Record it so the caller can tell the difference.
        warnings.push(
          `frame ${path.join("/") || "(top)"}: ${firstLine(error)}`,
        );
        continue;
      }

      if (handles.length !== metas.length) {
        // Document changed between the two calls. Drop this frame's elements
        // rather than risk pairing a nodeId with the wrong control.
        warnings.push(
          `frame ${path.join("/") || "(top)"}: document changed during observation ` +
            `(${handles.length} handles vs ${metas.length} metadata); frame skipped`,
        );
        for (const h of handles) await h.dispose().catch(() => {});
        continue;
      }

      framePaths.push(path);

      // A frameset document has no <body>. Asking for its accessibility snapshot
      // through a body locator does not fail — it silently waits out the
      // timeout, which made every observation of a framed application cost two
      // seconds and made replay record "slow renders" that were really its own
      // overhead. So the body is checked for directly; the content of a
      // frameset lives in its child frames, which are observed in their own right.
      const header = path.length === 0 ? "# frame: (top)" : `# frame: ${path.join(" > ")}`;
      const hasBody = await frame.evaluate(() => document.querySelector("body") !== null).catch(() => false);
      if (!hasBody) {
        treeParts.push(`${header}\n(no document body; content is in child frames)`);
      } else {
        try {
          const snapshot = await frame.locator("body").ariaSnapshot({ timeout: 2000 });
          treeParts.push(`${header}\n${snapshot}`);
        } catch {
          treeParts.push(`${header}\n(snapshot unavailable)`);
          warnings.push(`frame ${path.join("/") || "(top)"}: accessibility snapshot unavailable`);
        }
      }

      for (let i = 0; i < metas.length; i++) {
        const meta = metas[i];
        const handle = handles[i];
        if (meta === undefined || handle === undefined) continue;
        if (!meta.visible) {
          await handle.dispose().catch(() => {});
          continue;
        }
        const element: ObservedElement = {
          nodeId: nodeId++,
          actionable: true,
          role: meta.role,
          name: meta.name,
          value: meta.value,
          enabled: meta.enabled,
          visible: meta.visible,
          framePath: path,
          anchorText: meta.anchorText,
          hints: {
            tag: meta.tag,
            inputType: meta.inputType,
            domId: meta.domId,
            fieldName: meta.fieldName,
          },
        };
        elements.push(element);
        this.#handles.push({ element, handle });
      }

      // Readable values: static text a capability may need to return. Gathered
      // after the controls so node ids stay grouped, and capped so a large
      // grid cannot crowd the actionable controls out of the model's view.
      try {
        const readHandles = await frame.$$(READABLE_SELECTOR);
        const readMetas = await frame.evaluate(collectReadable, READABLE_SELECTOR);
        if (readHandles.length === readMetas.length) {
          let kept = 0;
          for (let i = 0; i < readMetas.length; i++) {
            if (kept >= MAX_READABLE_PER_FRAME) {
              await readHandles[i]?.dispose().catch(() => {});
              continue;
            }
            const meta = readMetas[i];
            const handle = readHandles[i];
            if (meta === undefined || handle === undefined) continue;
            if (!meta.keep) {
              await handle.dispose().catch(() => {});
              continue;
            }
            const element: ObservedElement = {
              nodeId: nodeId++,
              actionable: false,
              role: "text",
              name: "",
              value: meta.text,
              enabled: true,
              visible: true,
              framePath: path,
              anchorText: meta.anchorText,
              ...(meta.columnHeader === null
                ? {}
                : { grid: { columnHeader: meta.columnHeader, rowTexts: meta.rowTexts } }),
              hints: { tag: meta.tag, inputType: null, domId: null, fieldName: null },
            };
            elements.push(element);
            this.#handles.push({ element, handle });
            kept++;
          }
        } else {
          for (const h of readHandles) await h.dispose().catch(() => {});
        }
      } catch (error) {
        warnings.push(`frame ${path.join("/") || "(top)"}: readable scan failed: ${firstLine(error)}`);
      }
    }

    return {
      warnings,
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      framePaths,
      elements,
      tree: treeParts.join("\n\n"),
      capturedAt: new Date().toISOString(),
    };
  }

  async act(action: Action): Promise<ActResult> {
    try {
      switch (action.kind) {
        case "navigate":
          await this.page.goto(action.url);
          await this.#settle();
          return { ok: true };

        case "wait":
          await new Promise((r) => setTimeout(r, action.ms));
          return { ok: true };

        case "click": {
          const handle = this.#resolve(action.nodeId, true);
          await handle.click({ timeout: 5000 });
          await this.#settle();
          return { ok: true };
        }

        case "fill": {
          const handle = this.#resolve(action.nodeId, true);
          await handle.fill(action.value, { timeout: 5000 });
          return { ok: true };
        }

        case "select": {
          const handle = this.#resolve(action.nodeId, true);
          await handle.selectOption(action.value, { timeout: 5000 });
          return { ok: true };
        }

        case "read": {
          const handle = this.#resolve(action.nodeId, false);
          const value = await handle.inputValue().catch(() => null);
          const text = value ?? (await handle.textContent()) ?? "";
          return { ok: true, text: text.replace(/\s+/g, " ").trim() };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: true });
  }

  async close(): Promise<void> {
    await this.#disposeHandles();
    await this.browser.close().catch(() => {});
  }

  /** Elements observed in the most recent Observation, for callers that need detail. */
  findByNodeId(nodeId: number): ObservedElement | undefined {
    return this.#handles.find((h) => h.element.nodeId === nodeId)?.element;
  }

  /** Elements in a given frame, used by tests and by anchored-strategy derivation. */
  elementsInFrame(path: FramePath): readonly ObservedElement[] {
    return this.#handles.filter((h) => samePath(h.element.framePath, path)).map((h) => h.element);
  }

  #resolve(nodeId: number, requireActionable: boolean): ElementHandle<SVGElement | HTMLElement> {
    const entry = this.#handles.find((h) => h.element.nodeId === nodeId);
    if (entry === undefined) {
      throw new SurfaceError(`No element with nodeId ${nodeId} in the current observation`);
    }
    if (requireActionable && !entry.element.actionable) {
      throw new SurfaceError(
        `Node ${nodeId} is a readable value, not a control. It can only be used with read.`,
      );
    }
    return entry.handle;
  }

  async #settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await new Promise((r) => setTimeout(r, this.settleMs));
  }

  async #disposeHandles(): Promise<void> {
    for (const { handle } of this.#handles) await handle.dispose().catch(() => {});
    this.#handles = [];
  }
}

export interface LaunchOptions {
  readonly headed?: boolean;
  readonly settleMs?: number;
  /** Start URL. Omitted leaves the browser on about:blank until a navigate action. */
  readonly startUrl?: string;
}

/**
 * Launches a browser and returns a Surface over it.
 *
 * Headed is the default in the escalation path rather than here: a human taking
 * over a live session needs a window they can actually see, so the caller that
 * cares makes that choice explicitly.
 */
export async function launchWebSurface(options: LaunchOptions = {}): Promise<PlaywrightWebSurface> {
  const browser: Browser = await chromium.launch({ headless: options.headed !== true });
  const page: Page = await browser.newPage();
  if (options.startUrl !== undefined) {
    await page.goto(options.startUrl);
  }
  return new PlaywrightWebSurface(browser, page, options.settleMs ?? 250);
}
