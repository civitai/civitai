import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export type AdsTxtSource = { name: string; url: string; required: boolean };

/** First source wins a duplicate record, so the primary seller goes first. */
export const ADS_TXT_SOURCES: readonly AdsTxtSource[] = [
  { name: 'snigel', url: 'https://cdn.snigelweb.com/adengine/civitai.com/ads.txt', required: true },
  {
    name: 'sparteo',
    url: 'https://gateway.actirise.com/services/adstxt/1fa142b2-967b-579f-a55e-ca210a784d12',
    required: false,
  },
];

export const ADS_TXT_OWNER_DOMAIN = 'civitai.com';
// One global manager. Sparteo's file declares sparteo.com; revisit when its tag is turned on.
export const ADS_TXT_MANAGER_DOMAIN = 'snigelweb.com';

/** Where the route redirects when it cannot build a file with the primary seller in it. */
export const ADS_TXT_FALLBACK_URL = ADS_TXT_SOURCES[0].url;

const FETCH_TIMEOUT_MS = 5_000;
const HOUR_MS = 60 * 60 * 1000;
const MEMO_TTL_MS = HOUR_MS;
/** How long a smaller file must keep being served before it replaces the stored copy. */
const SHRINK_GRACE_MS = 24 * HOUR_MS;
/** Bounds last-good writes for an unchanged file; `checkedAt` is only as fresh as this. */
const CHECK_WRITE_INTERVAL_MS = 6 * HOUR_MS;
/** An optional source whose upstream has been gone this long is dropped rather than replayed. */
const OPTIONAL_FALLBACK_MAX_AGE_MS = 7 * 24 * HOUR_MS;
const lastGoodKey = (name: string) => `ads-txt:last-good:${name}`;

type AdsTxtRecord = { line: string; key: string };
type AdsTxtVariable = { key: string; value: string };
type SourceBody = {
  body: string;
  fetchedAt: string;
  recordCount: number;
  /** Last time the upstream served an accepted body. */
  checkedAt?: string;
  /** First rejection of a smaller body still pending its grace period. */
  shrinkSince?: string;
};

export function parseAdsTxt(text: string) {
  const records: AdsTxtRecord[] = [];
  const variables: AdsTxtVariable[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const variable = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
    if (variable) {
      variables.push({ key: variable[1].toUpperCase(), value: variable[2].trim() });
      continue;
    }
    const fields = line.split(',').map((f) => f.trim());
    if (fields.length < 3 || !fields[0] || !fields[1]) continue;
    const relationship = fields[2].toUpperCase();
    if (relationship !== 'DIRECT' && relationship !== 'RESELLER') continue;
    records.push({
      line: fields.join(', '),
      key: `${fields[0].toLowerCase()}|${fields[1]}|${relationship}`,
    });
  }
  return { records, variables };
}

type BodyVerdict = 'ok' | 'shrunk' | 'invalid';

/** An HTML page or an empty body is an error page; losing over half the records may be one. */
export function judgeAdsTxtBody(
  body: string,
  contentType: string | null,
  lastGoodCount = 0
): BodyVerdict {
  if (contentType?.toLowerCase().includes('text/html') || body.trimStart().startsWith('<'))
    return 'invalid';
  const count = parseAdsTxt(body).records.length;
  if (count === 0) return 'invalid';
  return count * 2 >= lastGoodCount ? 'ok' : 'shrunk';
}

export function mergeAdsTxt(sources: { name: string; body: string; note: string }[]) {
  const seen = new Set<string>();
  const contacts = new Set<string>();
  const otherVariables = new Set<string>();
  const sections: string[] = [];

  for (const source of sources) {
    const { records, variables } = parseAdsTxt(source.body);
    for (const { key, value } of variables) {
      if (key === 'OWNERDOMAIN' || key === 'MANAGERDOMAIN') continue;
      if (key === 'CONTACT') contacts.add(value);
      else otherVariables.add(`${key}=${value}`);
    }
    const lines = records.filter((r) => !seen.has(r.key)).map((r) => (seen.add(r.key), r.line));
    sections.push([`# ${source.name} (${source.note})`, ...lines].join('\n'));
  }

  const header = [
    `OWNERDOMAIN=${ADS_TXT_OWNER_DOMAIN}`,
    `MANAGERDOMAIN=${ADS_TXT_MANAGER_DOMAIN}`,
    ...[...contacts].map((c) => `CONTACT=${c}`),
    ...otherVariables,
  ];
  return [header.join('\n'), ...sections].join('\n\n') + '\n';
}

export class AdsTxtUnavailableError extends Error {}

export type AdsTxtDeps = {
  fetchSource: (
    url: string
  ) => Promise<{ status: number; contentType: string | null; body: string }>;
  getLastGood: (name: string) => Promise<SourceBody | undefined>;
  setLastGood: (name: string, value: SourceBody) => Promise<void>;
  now: () => Date;
  log: (data: Record<string, unknown>) => void;
};

const defaultDeps: AdsTxtDeps = {
  fetchSource: async (url) => {
    const res = await outboundFetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: await res.text(),
    };
  },
  getLastGood: (name) => dbKV.get<SourceBody>(lastGoodKey(name)),
  setLastGood: (name, value) => dbKV.set(lastGoodKey(name), value),
  now: () => new Date(),
  log: ({ message, ...payload }) =>
    logToAxiom({ name: 'ads-txt', type: 'warning', message: String(message), payload }),
};

const ageMs = (now: Date, iso: string | undefined) =>
  iso ? now.getTime() - Date.parse(iso) : Infinity;

async function resolveSource(source: AdsTxtSource, deps: AdsTxtDeps) {
  let readFailed = false;
  const lastGood = await deps.getLastGood(source.name).catch(() => {
    readFailed = true;
    return undefined;
  });
  const now = deps.now();
  // Without the stored copy there is no baseline to judge against, so nothing is written over it.
  const store = async (value: SourceBody) => {
    if (readFailed) return;
    await deps
      .setLastGood(source.name, value)
      .catch((error: Error) =>
        deps.log({ message: 'last-good write failed', source: source.name, error: error.message })
      );
  };
  let reason = 'upstream unavailable';

  try {
    const res = await deps.fetchSource(source.url);
    const verdict =
      res.status === 200
        ? judgeAdsTxtBody(res.body, res.contentType, lastGood?.recordCount)
        : 'invalid';
    const shrinkSettled =
      verdict === 'shrunk' &&
      !!lastGood?.shrinkSince &&
      ageMs(now, lastGood.shrinkSince) >= SHRINK_GRACE_MS;
    if (verdict === 'ok' || shrinkSettled) {
      const changed = res.body !== lastGood?.body;
      const fresh: SourceBody = {
        body: res.body,
        fetchedAt: changed || !lastGood ? now.toISOString() : lastGood.fetchedAt,
        recordCount: parseAdsTxt(res.body).records.length,
        checkedAt: now.toISOString(),
      };
      if (
        changed ||
        lastGood?.shrinkSince ||
        ageMs(now, lastGood?.checkedAt) >= CHECK_WRITE_INTERVAL_MS
      )
        await store(fresh);
      return { body: fresh.body, note: `fetched ${fresh.checkedAt}` };
    }
    if (verdict === 'shrunk' && lastGood) {
      reason = `smaller file held back since ${lastGood.shrinkSince ?? now.toISOString()}`;
      if (!lastGood.shrinkSince) await store({ ...lastGood, shrinkSince: now.toISOString() });
    }
    deps.log({ message: 'upstream rejected', source: source.name, status: res.status, verdict });
  } catch (error) {
    deps.log({ message: 'upstream failed', source: source.name, error: (error as Error).message });
  }

  if (!lastGood) return undefined;
  const confirmedAt = lastGood.checkedAt ?? lastGood.fetchedAt;
  if (!source.required && ageMs(now, confirmedAt) > OPTIONAL_FALLBACK_MAX_AGE_MS) {
    deps.log({ message: 'stored copy too old, source dropped', source: source.name });
    return undefined;
  }
  return {
    body: lastGood.body,
    note: `${reason}; last good copy confirmed ${confirmedAt}`,
  };
}

export async function buildAdsTxt(deps: AdsTxtDeps = defaultDeps) {
  const resolved = await Promise.all(
    ADS_TXT_SOURCES.map(async (source) => ({ source, body: await resolveSource(source, deps) }))
  );
  const missingRequired = resolved.find(({ source, body }) => source.required && !body);
  if (missingRequired)
    throw new AdsTxtUnavailableError(`no copy of ${missingRequired.source.name}`);
  return mergeAdsTxt(
    resolved.flatMap(({ source, body }) => (body ? [{ name: source.name, ...body }] : []))
  );
}

export const getAdsTxt = createTtlMemo(() => buildAdsTxt(), MEMO_TTL_MS);
