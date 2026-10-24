import { config } from '@/config';
import { logger } from '@/utils/logger';

export type QueueGateOptions = {
  /** Prometheus base URL; the standard instant-query API is used. */
  url: string;
  query: string;
  pauseAbove: number;
  resumeBelow: number;
  bearer?: string;
  /** How long one reading is trusted, and how often a paused gate re-checks. */
  refreshMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Holds embedding submits while the orchestrator's job queue is deep: closes above
 * `pauseAbove`, opens again only below `resumeBelow`, so it does not flap at the line. Fails
 * closed: a reading that cannot be taken holds submits until one can.
 */
export class QueueGate {
  private paused = false;
  private checkedAt = -Infinity;
  lastValue: number | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly refreshMs: number;

  constructor(private readonly opts: QueueGateOptions) {
    if (!(opts.resumeBelow < opts.pauseAbove)) {
      throw new Error('VECTOR_QUEUE_RESUME_BELOW must be below VECTOR_QUEUE_PAUSE_ABOVE');
    }
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.refreshMs = opts.refreshMs ?? 15_000;
  }

  /** A gate from config, or none when VECTOR_QUEUE_PROM_URL is unset. */
  static fromConfig(): QueueGate | undefined {
    const vs = config.vectorSync;
    if (!vs.queuePromUrl) return undefined;
    return new QueueGate({
      url: vs.queuePromUrl,
      query: vs.queuePromQuery,
      pauseAbove: vs.queuePauseAbove,
      resumeBelow: vs.queueResumeBelow,
      bearer: vs.queuePromBearer,
    });
  }

  async isOpen(): Promise<boolean> {
    if (this.now() - this.checkedAt >= this.refreshMs) await this.refresh();
    return !this.paused;
  }

  async waitOpen() {
    while (!(await this.isOpen())) await this.sleep(this.refreshMs);
  }

  private async refresh() {
    this.checkedAt = this.now();
    const was = this.paused;
    try {
      const value = await this.read();
      this.lastValue = value;
      if (value > this.opts.pauseAbove) this.paused = true;
      else if (value < this.opts.resumeBelow) this.paused = false;
    } catch (err) {
      this.lastValue = null;
      this.paused = true;
      logger.error({ err }, 'vector-sync: queue depth unreadable; holding submits');
    }
    if (this.paused !== was) {
      logger.warn(
        { queued: this.lastValue, paused: this.paused },
        this.paused
          ? 'vector-sync: orchestrator queue deep; holding submits'
          : 'vector-sync: queue drained; resuming'
      );
    }
  }

  private async read(): Promise<number> {
    const url = `${this.opts.url.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(
      this.opts.query
    )}`;
    const res = await this.fetch(url, {
      headers: this.opts.bearer ? { Authorization: `Bearer ${this.opts.bearer}` } : {},
    });
    if (!res.ok) throw new Error(`prometheus ${res.status}`);
    const body = (await res.json()) as {
      status?: string;
      data?: { result?: Array<{ value?: [number, string] }> };
    };
    // An empty result is treated as unreadable too: a renamed metric must not read as an empty queue.
    const raw = body.status === 'success' ? body.data?.result?.[0]?.value?.[1] : undefined;
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value))
      throw new Error('prometheus: no value for the queue query');
    return value;
  }
}
