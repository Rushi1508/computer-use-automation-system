/**
 * Token accounting and a hard spend ceiling for the discovery loop.
 *
 * An agent loop resends its entire conversation every turn, so cost grows
 * quadratically with step count unless the stable prefix is cached. Two things
 * follow from that, and both are implemented rather than hoped for:
 *
 *   - The system prompt and tool definitions carry a cache breakpoint, so from
 *     the second turn onward that prefix bills at roughly a tenth of the input
 *     rate instead of full price.
 *   - The loop tracks actual reported usage and stops itself at a configured
 *     ceiling. A step budget bounds how many actions run; it does not bound
 *     spend, because a single turn with a large observation costs far more than
 *     a small one.
 *
 * Rates are list prices in USD per million tokens. They are used only to
 * decide when to stop and what to report — nothing here bills anything.
 */

export interface ModelRates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

const RATES: Readonly<Record<string, ModelRates>> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Unknown models are priced at the most expensive known rate, so guessing is never cheap. */
export function ratesFor(model: string): ModelRates {
  return RATES[model] ?? { inputPerMTok: 5, outputPerMTok: 25 };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  turns: number;
}

export interface UsageLike {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

export class CostAccountant {
  readonly totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
  };

  constructor(private readonly model: string) {}

  add(usage: UsageLike | undefined | null): void {
    if (usage === undefined || usage === null) return;
    this.totals.turns += 1;
    this.totals.inputTokens += usage.input_tokens ?? 0;
    this.totals.outputTokens += usage.output_tokens ?? 0;
    this.totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }

  /** Estimated spend so far, in USD. */
  get costUsd(): number {
    const r = ratesFor(this.model);
    const perToken = r.inputPerMTok / 1_000_000;
    return (
      this.totals.inputTokens * perToken +
      this.totals.cacheWriteTokens * perToken * 1.25 +
      this.totals.cacheReadTokens * perToken * 0.1 +
      (this.totals.outputTokens * r.outputPerMTok) / 1_000_000
    );
  }

  /**
   * True when the cache is actually being used. If this stays false across
   * turns something is invalidating the prefix and the run is costing several
   * times what it should — worth surfacing rather than discovering on a bill.
   */
  get cacheIsWorking(): boolean {
    return this.totals.cacheReadTokens > 0;
  }

  summary(): string {
    const t = this.totals;
    return (
      `${t.turns} turns | in ${t.inputTokens} (+${t.cacheWriteTokens} cache write, ` +
      `${t.cacheReadTokens} cache read) | out ${t.outputTokens} | ~$${this.costUsd.toFixed(4)}`
    );
  }
}
