import client, { type Counter, type Gauge, type Registry } from 'prom-client';

const READS = 'profanity_list_reads_total';
const FALLBACK = 'profanity_list_fallback';
const HITS = 'profanity_hits_total';

export function ensureRegisterProfanityListMetrics(reg: Registry = client.register) {
  const reads =
    (reg.getSingleMetric(READS) as Counter<string> | undefined) ??
    new client.Counter({
      name: READS,
      help: 'Server reads of the profanity block list, by the list they enforced: managed (the moderator row), stale (this pod last good copy), fallback (the shipped list because the row was missing, below the floor or unreadable), shipped (flag off)',
      labelNames: ['source'],
      registers: [reg],
    });
  const fallback =
    (reg.getSingleMetric(FALLBACK) as Gauge<string> | undefined) ??
    new client.Gauge({
      name: FALLBACK,
      help: '1 while this pod enforces the shipped profanity list in place of a managed list it could not use',
      registers: [reg],
    });
  const hits =
    (reg.getSingleMetric(HITS) as Counter<string> | undefined) ??
    new client.Counter({
      name: HITS,
      help: 'Server profanity matches, by surface and by the list source that matched',
      labelNames: ['surface', 'source'],
      registers: [reg],
    });
  return { reads, fallback, hits };
}

export type ProfanityHitSurface = 'search' | 'mask' | 'appdata' | 'dryrun';
