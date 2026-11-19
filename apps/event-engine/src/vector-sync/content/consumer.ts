/**
 * Keeps the content search collections (articles, comics, challenges, ...) in step with Postgres:
 * `node dist/vector-sync/content/consumer.js`. One process and consumer group for all of them; it
 * runs the domains named in VECTOR_CONTENT_DOMAINS. Besides each domain's CDC topics it reads the
 * Outbox topic for the site's `search.update` rows.
 */
import { config } from '@/config';
import { logger } from '@/utils/logger';
import { runSyncConsumer, routeByTopic, type Route } from '../domain/consumer';
import type { Domain } from '../domain/sync';
import { CONTENT_DOMAINS } from './domains';

export const OUTBOX_TOPIC = 'postgres.Outbox';
export const SEARCH_UPDATE = 'search.update';

/** The domains to run, refusing names that do not exist and an empty list. */
export function selectDomains(names: string[], all: Domain<any>[] = CONTENT_DOMAINS) {
  if (!names.length) throw new Error('VECTOR_CONTENT_DOMAINS names no domain');
  const unknown = names.filter((n) => !all.some((d) => d.name === n));
  if (unknown.length) throw new Error(`Unknown content domains: ${unknown.join(', ')}`);
  return all.filter((d) => names.includes(d.name));
}

/**
 * Routes the domains' own topics, plus Outbox inserts of `search.update` rows to the domain whose
 * outboxEntity they name. Other Outbox rows belong to the main event processor.
 */
export function contentRoute(domains: Domain<any>[]): Route {
  const byTopic = routeByTopic(domains);
  return (topic, value) => {
    if (topic !== OUTBOX_TOPIC) return byTopic(topic, value);
    const event = value as { op?: string; after?: Record<string, unknown> | null } | null;
    const row = event?.op === 'c' ? event.after : null;
    if (row?.event !== SEARCH_UPDATE) return [];
    const domain = domains.find((d) => d.outboxEntity && d.outboxEntity === row.entityType);
    const id = Number(row.entityId);
    return domain && Number.isSafeInteger(id) && id > 0 ? [[domain.name, { id }]] : [];
  };
}

/** The tables the chosen domains need streamed; refuses to start while any is missing. */
export function assertContentCdc(domains: Domain<any>[]) {
  const streamed = [...config.kafka.monitoredTables, ...config.kafka.cdcOnlyTables];
  const missing = domains.flatMap((d) => d.cdcTables).filter((t) => !streamed.includes(t));
  if (missing.length)
    throw new Error(`Not streamed (CDC_CONTENT_ENABLED off?): ${[...new Set(missing)].join(', ')}`);
}

if (require.main === module) {
  try {
    const domains = selectDomains(config.vectorSync.contentDomains);
    assertContentCdc(domains);
    const topics = [...new Set([OUTBOX_TOPIC, ...domains.flatMap((d) => d.topics)])];
    runSyncConsumer({
      log: 'content-sync',
      clientId: 'content-vector-sync',
      groupId: config.vectorSync.contentConsumerGroup,
      domains,
      topics,
      route: contentRoute(domains),
    }).catch((err) => {
      logger.error({ err }, 'content-sync: failed to start');
      process.exit(1);
    });
  } catch (err) {
    logger.error({ err }, 'content-sync: failed to start');
    process.exit(1);
  }
}
