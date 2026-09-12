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
 */
function collectMeta(selector: string): RawElementMeta[] {
  const els = Array.from(document.querySelectorAll(selector));

  const textOf = (node: Element | null): string =>
    (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit !== null && explicit !== "") return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    return "generic";
  };

  const nameOf = (el: Element): string => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy !== null && labelledBy !== "") {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter((s) => s !== "");
      if (parts.length > 0) return parts.join(" ");
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel.trim() !== "") return ariaLabel.trim();

    const labels = (el as HTMLInputElement).labels;
    if (labels !== undefined && labels !== null && labels.length > 0) {
      const joined = Array.from(labels).map(textOf).filter((s) => s !== "").join(" ");
      if (joined !== "") return joined;
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset") {
        const v = (el as HTMLInputElement).value;
        if (v !== "") return v;
      }
    }
    if (tag === "button" || tag === "a") {
      const t = textOf(el);
      if (t !== "") return t;
    }

    const title = el.getAttribute("title");
    if (title !== null && title.trim() !== "") return title.trim();

    // No accessible name. This is a real answer, not a failure.
    return "";
  };

  /**
   * The text that identifies an unnamed control to a human reading the screen.
   * On table-laid-out legacy forms that is the first cell of the containing row
   * that does not itself contain the control.
   */
  const anchorOf = (el: Element): string | null => {
    const row = el.closest("tr");
    if (row !== null) {
      for (const cell of Array.from(row.children)) {
        if (cell.contains(el)) continue;
        const t = textOf(cell);
        if (t !== "") return t;
      }
    }
    const prev = el.previousElementSibling;
    if (prev !== null) {
      const t = textOf(prev);
      if (t !== "") return t;
    }
    return null;
  };

  return els.map((el) => {
    const tag = el.tagName.toLowerCase();
    const rects = el.getClientRects();
    const input = el as HTMLInputElement;
    return {
      role: roleOf(el),
      name: nameOf(el),
      value: tag === "input" || tag === "select" || tag === "textarea" ? (input.value ?? null) : null,
      enabled: !(input.disabled ?? false),
      visible: rects.length > 0,
      anchorText: anchorOf(el),
      tag,
      inputType: tag === "input" ? (el.getAttribute("type") ?? "text") : null,
      domId: el.getAttribute("id"),
      fieldName: el.getAttribute("name"),
    };
  });
}

function framePathOf(frame: Frame): FramePath {
  const path: string[] = [];
  let current: Frame | null = frame;
  while (current !== null) {
    const parent: Frame | null = current.parentFrame();
    if (parent === null) break; // top document contributes no segment
    const name = current.name();
    path.unshift(name !== "" ? name : `frame@${current.url()}`);
    current = parent;
  }
  return path;
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
      } catch {
        continue; // a frame can navigate out from under us mid-observation
      }

      if (handles.length !== metas.length) {
        // Document changed between the two calls. Drop this frame's elements
        // rather than risk pairing a nodeId with the wrong control.
        for (const h of handles) await h.dispose().catch(() => {});
        continue;
      }

      framePaths.push(path);

      try {
        const snapshot = await frame.locator("body").ariaSnapshot({ timeout: 2000 });
        treeParts.push(
          path.length === 0 ? `# frame: (top)\n${snapshot}` : `# frame: ${path.join(" > ")}\n${snapshot}`,
        );
      } catch {
        treeParts.push(`# frame: ${path.join(" > ") || "(top)"}\n(snapshot unavailable)`);
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
    }

    return {
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
          const handle = this.#resolve(action.nodeId);
          await handle.click({ timeout: 5000 });
          await this.#settle();
          return { ok: true };
        }

        case "fill": {
          const handle = this.#resolve(action.nodeId);
          await handle.fill(action.value, { timeout: 5000 });
          return { ok: true };
        }

        case "select": {
          const handle = this.#resolve(action.nodeId);
          await handle.selectOption(action.value, { timeout: 5000 });
          return { ok: true };
        }

        case "read": {
          const handle = this.#resolve(action.nodeId);
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

  #resolve(nodeId: number): ElementHandle<SVGElement | HTMLElement> {
    const entry = this.#handles.find((h) => h.element.nodeId === nodeId);
    if (entry === undefined) {
      throw new SurfaceError(`No element with nodeId ${nodeId} in the current observation`);
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
