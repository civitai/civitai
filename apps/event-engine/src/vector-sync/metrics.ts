import type { ServerResponse } from 'http';
import { Counter, Histogram } from 'prom-client';
import { register } from '@/metrics';
import type { Embedder } from './embedder';

/** `domain` is image, model, article, ...: one series per index. */
export const vectorSyncMetrics = {
  points: new Counter({
    name: 'vector_sync_points_total',
    help: 'Points written to or removed from a vector index, by outcome (embedded, updated, deleted, failed)',
    labelNames: ['domain', 'outcome'],
    registers: [register],
  }),
  skipped: new Counter({
    name: 'vector_sync_points_skipped_total',
    help: 'Rows a vector sync left alone, by reason (unchanged, embed-off, video-disabled, ...)',
    labelNames: ['domain', 'reason'],
    registers: [register],
  }),
  /**
   * A flush that throws records no counts, like its log line. Vectors it stored before failing
   * count as updated or unchanged on the retry, so `embedded` undercounts paid embeds by that much.
   */
  flushErrors: new Counter({
    name: 'vector_sync_flush_errors_total',
    help: 'Flushes that threw and were put back for the next tick',
    labelNames: ['domain'],
    registers: [register],
  }),
  embedSeconds: new Histogram({
    name: 'vector_sync_embed_duration_seconds',
    help: 'Wall time of one embed call for a flush batch, including rate-limit waits',
    labelNames: ['domain'],
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [register],
  }),
};

type FlushCounts = {
  embedded: number;
  updated: number;
  deleted: number;
  failed: number;
  embedOff: number;
  unchanged?: number;
  skipped?: Record<string, number>;
};

/** Counts the same numbers a flush logs. */
export function recordFlush(domain: string, stats: FlushCounts) {
  for (const outcome of ['embedded', 'updated', 'deleted', 'failed'] as const)
    if (stats[outcome]) vectorSyncMetrics.points.inc({ domain, outcome }, stats[outcome]);
  const skipped: Record<string, number> = {
    ...stats.skipped,
    unchanged: stats.unchanged ?? 0,
    'embed-off': stats.embedOff,
  };
  for (const [reason, n] of Object.entries(skipped))
    if (n) vectorSyncMetrics.skipped.inc({ domain, reason }, n);
}

type Embed = Pick<Embedder, 'embed'>;

export function timeEmbeds(domain: string, embedder: Embed): Embed {
  return {
    embed: async (...args) => {
      const end = vectorSyncMetrics.embedSeconds.startTimer({ domain });
      try {
        return await embedder.embed(...args);
      } finally {
        end();
      }
    },
  };
}

/** The vector-sync processes answer /metrics on their health port with the shared registry. */
export async function serveMetrics(res: ServerResponse) {
  try {
    const body = await register.metrics();
    res.writeHead(200, { 'Content-Type': register.contentType });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end();
  }
}
