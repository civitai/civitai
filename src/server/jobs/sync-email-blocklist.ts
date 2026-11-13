import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { upsertBlocklist } from '~/server/services/blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { outboundFetch } from '~/server/utils/fetch-timeout';

const log = createLogger('jobs:sync-email-blocklist', 'blue');

const UPSTREAM_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';

// Sanity floor: upstream had ~10k entries when this job was written. A response
// far below that means an empty/HTML/redirect response and we should bail.
const MIN_UPSTREAM_ENTRIES = 5000;

function parseUpstream(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    seen.add(line);
  }
  return [...seen];
}

export const syncEmailBlocklist = createJob('sync-email-blocklist', '0 3 * * 0', async () => {
  let upstreamText: string;
  try {
    const res = await outboundFetch(UPSTREAM_URL, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`upstream returned ${res.status}`);
    upstreamText = await res.text();
  } catch (error) {
    const err = error as Error;
    logToAxiom({
      type: 'error',
      name: 'sync-email-blocklist',
      message: `fetch failed: ${err.message}`,
    });
    return;
  }

  const upstream = parseUpstream(upstreamText);
  if (upstream.length < MIN_UPSTREAM_ENTRIES) {
    logToAxiom({
      type: 'error',
      name: 'sync-email-blocklist',
      message: `upstream below sanity floor (${upstream.length} < ${MIN_UPSTREAM_ENTRIES})`,
    });
    return;
  }

  const rows = await dbWrite.blocklist.findMany({
    where: { type: BlocklistType.EmailDomain },
    select: { id: true, data: true },
  });

  if (rows.length === 0) {
    logToAxiom({
      type: 'warning',
      name: 'sync-email-blocklist',
      message: 'no EmailDomain row found; skipping (seed manually first)',
    });
    return;
  }
  if (rows.length > 1) {
    logToAxiom({
      type: 'error',
      name: 'sync-email-blocklist',
      message: `multiple EmailDomain rows (${rows.length}); skipping until consolidated`,
    });
    return;
  }

  const [{ id, data: existing }] = rows;
  const existingSet = new Set(existing);
  const additions = upstream.filter((d) => !existingSet.has(d));

  if (additions.length === 0) {
    log('no new domains');
    return;
  }

  await upsertBlocklist({
    id,
    type: BlocklistType.EmailDomain,
    blocklist: additions,
  });

  logToAxiom({
    type: 'info',
    name: 'sync-email-blocklist',
    message: `added ${additions.length} domains`,
    added: additions.length,
    totalAfter: existing.length + additions.length,
    sample: additions.slice(0, 10),
  });
  log(`added ${additions.length} domains`);
});
