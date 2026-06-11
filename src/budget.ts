// Central budget guard. Every sub-call passes through checkBeforeCall()/record(),
// so no loop in the pipeline can run away on calls, tokens, cost, or wall time.

import type { BudgetConfig, BudgetSnapshot, UsageTotals } from "./types.ts";

export class BudgetExhaustedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`apodex budget exhausted: ${reason}`);
    this.name = "BudgetExhaustedError";
    this.reason = reason;
  }
}

export class Budget {
  private readonly config: BudgetConfig;
  private readonly startedAt: number;
  private subCalls = 0;
  private totalTokens = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;

  constructor(config: BudgetConfig) {
    this.config = config;
    this.startedAt = Date.now();
  }

  /** Throws BudgetExhaustedError if the next sub-call would exceed any limit. */
  checkBeforeCall(): void {
    const reason = this.exhaustedReason();
    if (reason) throw new BudgetExhaustedError(reason);
  }

  exhaustedReason(): string | null {
    if (this.subCalls >= this.config.maxSubCalls) {
      return `sub-call limit reached (${this.subCalls}/${this.config.maxSubCalls})`;
    }
    if (this.totalTokens >= this.config.maxTotalTokens) {
      return `token limit reached (${this.totalTokens}/${this.config.maxTotalTokens})`;
    }
    if (this.costUsd >= this.config.maxCostUsd) {
      return `cost limit reached ($${this.costUsd.toFixed(4)}/$${this.config.maxCostUsd})`;
    }
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.config.maxWallTimeMs) {
      return `wall-time limit reached (${Math.round(elapsed / 1000)}s/${Math.round(this.config.maxWallTimeMs / 1000)}s)`;
    }
    return null;
  }

  record(usage: UsageTotals): void {
    this.subCalls += 1;
    this.totalTokens += usage.input + usage.output;
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.costUsd += usage.costUsd;
  }

  snapshot(): BudgetSnapshot {
    return {
      subCalls: this.subCalls,
      totalTokens: this.totalTokens,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      elapsedMs: Date.now() - this.startedAt,
      limits: { ...this.config },
    };
  }
}
