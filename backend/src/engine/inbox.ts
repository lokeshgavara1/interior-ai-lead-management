import type { EngineDeps } from './deps.js';
import { processLead } from './conversation.js';

/**
 * Debounces customer bursts and serialises processing per lead.
 *
 *  - Each new message (re)starts a short timer for its lead, so "Hi" + "I need
 *    interiors" + "3BHK in Kondapur" become ONE AI turn and ONE reply.
 *  - Processing for the same lead never runs concurrently (promise chain).
 *  - A sweeper picks up anything missed (restart, crash) from the database,
 *    because pending messages are stored durably before we ack the webhook.
 *
 * Single-instance design. To run several instances, replace with a queue that
 * supports per-key concurrency (e.g. BullMQ groups) — the DB claim RPC already
 * prevents double processing of the same message.
 */
export class Inbox {
  private timers = new Map<string, NodeJS.Timeout>();
  private chains = new Map<string, Promise<void>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private deps: EngineDeps,
    private debounceMs: number,
    private process: (deps: EngineDeps, leadId: string) => Promise<void> = processLead,
  ) {}

  schedule(leadId: string): void {
    const existing = this.timers.get(leadId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      leadId,
      setTimeout(() => {
        this.timers.delete(leadId);
        void this.run(leadId);
      }, this.debounceMs),
    );
  }

  /** Runs processing for a lead after any in-flight run for that lead finishes. */
  run(leadId: string): Promise<void> {
    const prev = this.chains.get(leadId) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(this.deps, leadId))
      .catch((err) => this.deps.log.error({ err, leadId }, 'inbox processing failed'))
      .finally(() => {
        if (this.chains.get(leadId) === next) this.chains.delete(leadId);
      });
    this.chains.set(leadId, next);
    return next;
  }

  startSweeper(intervalMs = 30_000): void {
    const sweep = async () => {
      try {
        const stuck = await this.deps.repo.resetStaleProcessing(5 * 60_000);
        const missed = await this.deps.repo.leadsWithStalePending(this.debounceMs * 3);
        for (const leadId of new Set([...stuck, ...missed])) {
          if (!this.timers.has(leadId) && !this.chains.has(leadId)) void this.run(leadId);
        }
      } catch (err) {
        this.deps.log.error({ err }, 'inbox sweeper failed');
      }
    };
    void sweep();
    this.sweeper = setInterval(sweep, intervalMs);
  }

  /** Graceful shutdown: flush pending timers and wait for in-flight work. */
  async drain(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const [leadId, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(leadId);
      void this.run(leadId);
    }
    await Promise.allSettled([...this.chains.values()]);
  }
}
