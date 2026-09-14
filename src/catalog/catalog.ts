/**
 * The capability catalog.
 *
 * A recorded capability is only worth recording if something can find it later.
 * The catalog is that index: it reads the artifact directory, groups immutable
 * versions under their id, and hands a caller either a human-readable listing
 * or the typed tool definitions an agent is given to invoke one.
 *
 * Four decisions shape it.
 *
 * 1. An unreadable artifact is REPORTED, never skipped. A catalog that quietly
 *    drops the file it could not parse tells an operator their capability does
 *    not exist, when the truth is that it is malformed — and the two call for
 *    completely different actions. Problems are part of the listing.
 *
 * 2. Tool names are UNVERSIONED. An agent asks for `lookup_member_savings_balance`
 *    and gets the newest version, because an agent should not have to chase
 *    version bumps; a scheduled job that must not move under it pins `--version`.
 *    What makes that safe is that the tool schema an agent receives is generated
 *    from the version it will actually run, so a changed contract reaches the
 *    caller as a changed contract rather than as a runtime surprise. Where the
 *    change would break a caller written against the previous version, the
 *    catalog says so — see `contractChange`.
 *
 * 3. Drafts are LISTED AND CALLABLE. `approvalState` does not gate invocation;
 *    it gates unattended execution of irreversible steps, which the policy
 *    engine enforces at the moment such a step is reached. Hiding drafts would
 *    hide capabilities that are entirely safe to run (a lookup has nothing
 *    irreversible in it) while adding no protection to the ones that are not.
 *    So a draft is offered, and its tool description says what a caller needs to
 *    know: an irreversible step will stop and wait for a person.
 *
 * 4. A capability whose app profile cannot be resolved is listed as BROKEN
 *    rather than omitted. Its outcome and recovery vocabulary lives in that
 *    profile, so replay would fail on it; better to show it with the reason
 *    attached than to leave someone wondering where their capability went.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ToolDefinition } from "../agent/tools.js";
import { appProfile } from "../schema/app-profile.js";
import { invocationSchema, type Capability } from "../schema/capability.js";
import { readCapabilityFile } from "../schema/load.js";

/** Where artifacts live. Subdirectories are not scanned, which keeps `reviews/` out. */
export const CAPABILITY_DIR = "capabilities";

export interface VersionedCapability {
  readonly capability: Capability;
  /** Path the artifact was read from, so a reviewer can go straight to it. */
  readonly file: string;
}

export interface CatalogEntry {
  readonly id: string;
  /** Ascending by version. Versions are immutable, so this is the full history. */
  readonly versions: readonly VersionedCapability[];
  /** Highest version. What an unversioned invocation binds to. */
  readonly latest: VersionedCapability;
  /**
   * Why this capability cannot currently be replayed, if it cannot. Empty for a
   * healthy entry.
   */
  readonly blockers: readonly string[];
}

/** A file in the directory that is not a usable artifact. */
export interface CatalogProblem {
  readonly file: string;
  readonly message: string;
}

export type Resolution =
  | { readonly ok: true; readonly entry: CatalogEntry; readonly selected: VersionedCapability }
  | { readonly ok: false; readonly message: string };

/**
 * How the newest version differs from the one before it, in terms a caller
 * already bound to the old one cares about.
 *
 * `breaking` is specifically about invocations, not about the flow: an input
 * that became required, an input that disappeared (unknown inputs are rejected,
 * so yesterday's valid call is today's error), or an output that is no longer
 * returned. A new outcome code is not breaking — the call still succeeds — but
 * it is listed separately because a caller that does not handle it will treat a
 * legitimate answer as an unknown one.
 */
export interface ContractChange {
  readonly from: number;
  readonly to: number;
  readonly breaking: boolean;
  readonly addedInputs: readonly string[];
  readonly removedInputs: readonly string[];
  readonly newlyRequiredInputs: readonly string[];
  readonly addedOutputs: readonly string[];
  readonly removedOutputs: readonly string[];
  readonly addedOutcomes: readonly string[];
  readonly removedOutcomes: readonly string[];
}

const names = (items: readonly { readonly name: string }[]): string[] => items.map((i) => i.name);
const missing = (from: readonly string[], present: readonly string[]): string[] =>
  from.filter((name) => !present.includes(name));

export function contractChange(previous: Capability, next: Capability): ContractChange {
  const wasRequired = new Set(previous.inputs.filter((i) => i.required).map((i) => i.name));
  const newlyRequiredInputs = next.inputs
    .filter((i) => i.required && !wasRequired.has(i.name))
    .map((i) => i.name);

  const removedInputs = missing(names(previous.inputs), names(next.inputs));
  const removedOutputs = missing(names(previous.outputs), names(next.outputs));
  const previousCodes = previous.knownOutcomes.map((o) => o.code);
  const nextCodes = next.knownOutcomes.map((o) => o.code);

  return {
    from: previous.version,
    to: next.version,
    breaking: newlyRequiredInputs.length > 0 || removedInputs.length > 0 || removedOutputs.length > 0,
    addedInputs: missing(names(next.inputs), names(previous.inputs)),
    removedInputs,
    newlyRequiredInputs,
    addedOutputs: missing(names(next.outputs), names(previous.outputs)),
    removedOutputs,
    addedOutcomes: missing(nextCodes, previousCodes),
    removedOutcomes: missing(previousCodes, nextCodes),
  };
}

/** The change, if any, that the latest version introduced. */
export function latestContractChange(entry: CatalogEntry): ContractChange | null {
  const previous = entry.versions.at(-2);
  if (previous === undefined) return null;
  return contractChange(previous.capability, entry.latest.capability);
}

/** Whether this capability has a step a person must approve while it is a draft. */
export function heldSteps(capability: Capability): number[] {
  if (capability.approvalState === "approved") return [];
  return capability.steps.filter((s) => s.risk === "risky_irreversible").map((s) => s.index);
}

export class Catalog {
  private constructor(
    readonly entries: readonly CatalogEntry[],
    readonly problems: readonly CatalogProblem[],
  ) {}

  /** Builds a catalog from artifacts already in memory. Used by tests and by callers that load their own. */
  static from(
    items: readonly VersionedCapability[],
    problems: readonly CatalogProblem[] = [],
  ): Catalog {
    const byId = new Map<string, VersionedCapability[]>();
    const collisions = [...problems];

    for (const item of items) {
      const siblings = byId.get(item.capability.id) ?? [];
      const clash = siblings.find((s) => s.capability.version === item.capability.version);
      if (clash !== undefined) {
        // Two files claiming the same version of the same capability means one
        // of them is not what its name says. Picking either would make replay
        // depend on directory order.
        collisions.push({
          file: item.file,
          message: `duplicate: ${item.capability.id} v${item.capability.version} is also defined in ${clash.file}`,
        });
        continue;
      }
      siblings.push(item);
      byId.set(item.capability.id, siblings);
    }

    const entries = [...byId.entries()]
      .map(([id, versions]): CatalogEntry => {
        const ordered = [...versions].sort((a, b) => a.capability.version - b.capability.version);
        const latest = ordered.at(-1) as VersionedCapability;
        return { id, versions: ordered, latest, blockers: blockersFor(latest.capability) };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return new Catalog(entries, collisions);
  }

  /**
   * Scans a directory of artifacts. Only files directly inside it are read, so
   * `capabilities/reviews/` and `capabilities/approvals/`, which hold proposed
   * edits and approval records rather than capabilities, are skipped by
   * construction rather than by a name check that could rot.
   */
  static load(dir: string = CAPABILITY_DIR): Catalog {
    const items: VersionedCapability[] = [];
    const problems: CatalogProblem[] = [];

    let listing: readonly string[];
    try {
      listing = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name)
        .sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const why = code === "ENOENT" ? "does not exist" : code === "ENOTDIR" ? "is not a directory" : "cannot be read";
      return new Catalog([], [{ file: dir, message: why }]);
    }

    for (const name of listing) {
      const file = join(dir, name);
      // The same loader every command uses, so the catalog shows exactly the
      // validation result and approval state an invocation would get.
      const loaded = readCapabilityFile(file);
      if (!loaded.ok) {
        problems.push({ file, message: loaded.problem });
        continue;
      }
      const { capability } = loaded;
      for (const warning of loaded.warnings) problems.push({ file, message: warning });
      const expected = `${capability.id}.v${capability.version}.json`;
      if (name !== expected) {
        // The rest of the system writes and reads artifacts by this
        // convention, so a file that breaks it is one someone will later
        // fail to find — or will overwrite believing it to be another version.
        problems.push({ file, message: `holds ${capability.id} v${capability.version}, so it should be named ${expected}` });
      }
      items.push({ capability, file });
    }

    return Catalog.from(items, problems);
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /**
   * Selects the version an invocation will run: the newest unless one is named.
   * Returns a message rather than throwing, because every caller of this is
   * reporting to a person or an agent, and both want the near-misses.
   */
  resolve(id: string, version?: number): Resolution {
    const entry = this.get(id);
    if (entry === undefined) {
      const known = this.entries.map((e) => e.id);
      const near = known.filter((k) => k.includes(id) || id.includes(k));
      const suggestion = (near.length > 0 ? near : known).join(", ");
      return {
        ok: false,
        message:
          `no capability '${id}' in the catalog.` +
          (suggestion === "" ? "" : ` Known: ${suggestion}`),
      };
    }

    if (version === undefined) return { ok: true, entry, selected: entry.latest };

    const selected = entry.versions.find((v) => v.capability.version === version);
    if (selected === undefined) {
      return {
        ok: false,
        message:
          `${id} has no version ${version}. Available: ` +
          entry.versions.map((v) => `v${v.capability.version}`).join(", "),
      };
    }
    return { ok: true, entry, selected };
  }

  /**
   * The tools an agent is offered, one per capability, bound to its newest
   * version. Input schemas come from `invocationSchema`, so the contract a model
   * is shown is generated from the same definitions the runtime validates
   * against and cannot drift from them.
   *
   * Capabilities that cannot be replayed are not offered. Nothing is gained by
   * letting a model call something that is guaranteed to fail.
   */
  toolDefinitions(): ToolDefinition[] {
    return this.entries
      .filter((entry) => entry.blockers.length === 0)
      .map((entry) => ({
        name: entry.id,
        description: toolDescription(entry.latest.capability),
        input_schema: invocationSchema(entry.latest.capability) as ToolDefinition["input_schema"],
      }));
  }
}

/**
 * The agent-facing description.
 *
 * Everything here answers a question a calling model has to get right: what
 * comes back, which answers are legitimate rather than failures, and whether
 * the call may stop partway to wait for a person. The outcome vocabulary is the
 * important one — a model told only "returns the savings balance" will read
 * MEMBER_NOT_FOUND as a malfunction and retry it.
 */
export function toolDescription(capability: Capability): string {
  const parts = [`${capability.description} (v${capability.version})`];

  if (capability.outputs.length > 0) {
    parts.push(
      "Returns: " +
        capability.outputs.map((o) => `${o.name} (${o.type}) — ${o.description}`).join("; "),
    );
  }

  if (capability.knownOutcomes.length > 0) {
    parts.push(
      "Business outcomes — legitimate answers, not errors; do not retry them: " +
        capability.knownOutcomes.map((o) => `${o.code} (${o.description})`).join("; "),
    );
  }

  const held = heldSteps(capability);
  if (held.length > 0) {
    parts.push(
      `This capability is a draft and has ${held.length === 1 ? "an irreversible step" : `${held.length} irreversible steps`}. ` +
        "Invoking it pauses for a human operator to approve that step, so the call may take minutes.",
    );
  }

  return parts.join("\n\n");
}

/** Reasons this capability could not be replayed as it stands. */
function blockersFor(capability: Capability): string[] {
  const blockers: string[] = [];
  try {
    appProfile(capability.surface.appProfileId);
  } catch (error) {
    blockers.push(reason(error));
  }
  return blockers;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
