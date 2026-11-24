import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

// Which ClickHouse the two download reads use: the dedicated downloads replica
// (~/server/clickhouse/downloads-client) or the shared one. See USER_DOWNLOADS_DEDICATED_CLICKHOUSE
// and DOWNLOAD_COUNT_DEDICATED_CLICKHOUSE in ~/server/flipt/client for what each flag does.

export type DownloadsReadSite = 'user-downloads' | 'download-count';

const readUserDownloadsFlag = readFliptSwitch(
  () => FLIPT_FEATURE_FLAGS.USER_DOWNLOADS_DEDICATED_CLICKHOUSE
);
const readDownloadCountFlag = readFliptSwitch(
  () => FLIPT_FEATURE_FLAGS.DOWNLOAD_COUNT_DEDICATED_CLICKHOUSE
);

let userDownloadsGate = createCachedFlagGate(readUserDownloadsFlag);
let downloadCountGate = createCachedFlagGate(readDownloadCountFlag);

/**
 * True only when the dedicated client exists AND the site's flag is on. Each flag is read at most
 * once per 5s per process; unknown or a throw reads as OFF. Without the client the flag is not read
 * at all, so turning it on in an environment that lacks the env is a no-op.
 */
export function readsDedicatedDownloadsClickhouse(
  site: DownloadsReadSite,
  dedicatedConfigured: boolean
): boolean {
  if (!dedicatedConfigured) return false;
  return site === 'user-downloads' ? userDownloadsGate() : downloadCountGate();
}

const fallbackCounter = registerCounterWithLabels({
  name: 'downloads_clickhouse_fallback_total',
  help: 'Download reads that failed on the dedicated downloads ClickHouse and were re-run once on the shared one, by read site and whether the dedicated read timed out',
  labelNames: ['site', 'reason'] as const,
});

// clickhouse-js rejects with this message when its request timeout fires before a response.
const isTimeout = (error: unknown) =>
  error instanceof Error && /timeout/i.test(error.message ?? '');

/**
 * Runs `dedicated`; if it rejects, counts the fallback and runs `shared` ONCE, whose result or
 * error is the caller's. The dedicated client has already re-sent a connection-reset read once
 * itself, so this is the last attempt there is.
 */
export async function withSharedClickhouseFallback<T>(
  site: DownloadsReadSite,
  dedicated: () => Promise<T>,
  shared: () => Promise<T>
): Promise<T> {
  try {
    return await dedicated();
  } catch (error) {
    fallbackCounter.inc({ site, reason: isTimeout(error) ? 'timeout' : 'error' });
    return shared();
  }
}

/** Tests only: forget the cached flag reads. */
export function resetDownloadsClickhouseGatesForTests() {
  userDownloadsGate = createCachedFlagGate(readUserDownloadsFlag);
  downloadCountGate = createCachedFlagGate(readDownloadCountFlag);
}
