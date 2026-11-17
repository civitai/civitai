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

/** The file served when no merged file can be built: today's redirect target. */
export const ADS_TXT_FALLBACK_URL = ADS_TXT_SOURCES[0].url;

const FETCH_TIMEOUT_MS = 5_000;
const MEMO_TTL_MS = 60 * 60 * 1000;
const lastGoodKey = (name: string) => `ads-txt:last-good:${name}`;

type AdsTxtRecord = { line: string; key: string };
type AdsTxtVariable = { key: string; value: string };
type SourceBody = { body: string; fetchedAt: string; recordCount: number };

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

/** A 200 that is HTML, or that lost more than half its records, is an error page, not a file. */
export function isAcceptableBody(body: string, contentType: string | null, lastGoodCount = 0) {
  if (contentType?.toLowerCase().includes('text/html') || body.trimStart().startsWith('<'))
    return false;
  const count = parseAdsTxt(body).records.length;
  return count > 0 && count * 2 >= lastGoodCount;
}

export function mergeAdsTxt(sources: { name: string; body: string; fetchedAt: string }[]) {
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
    sections.push([`# ${source.name} (fetched ${source.fetchedAt})`, ...lines].join('\n'));
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
  log: (data) => logToAxiom({ name: 'ads-txt', type: 'warning', ...data }).catch(() => undefined),
};

async function resolveSource(source: AdsTxtSource, deps: AdsTxtDeps) {
  const lastGood = await deps.getLastGood(source.name).catch(() => undefined);
  try {
    const res = await deps.fetchSource(source.url);
    if (res.status === 200 && isAcceptableBody(res.body, res.contentType, lastGood?.recordCount)) {
      const fresh: SourceBody = {
        body: res.body,
        fetchedAt: deps.now().toISOString(),
        recordCount: parseAdsTxt(res.body).records.length,
      };
      if (fresh.body !== lastGood?.body) {
        await deps
          .setLastGood(source.name, fresh)
          .catch((error: Error) =>
            deps.log({
              message: 'last-good write failed',
              source: source.name,
              error: error.message,
            })
          );
      }
      return fresh;
    }
    deps.log({ message: 'upstream rejected', source: source.name, status: res.status });
  } catch (error) {
    deps.log({ message: 'upstream failed', source: source.name, error: (error as Error).message });
  }
  return lastGood;
}

export async function buildAdsTxt(deps: AdsTxtDeps = defaultDeps) {
  const resolved = await Promise.all(
    ADS_TXT_SOURCES.map(async (source) => ({ source, body: await resolveSource(source, deps) }))
  );
  const missingRequired = resolved.find(({ source, body }) => source.required && !body);
  if (missingRequired)
    throw new AdsTxtUnavailableError(`no copy of ${missingRequired.source.name}`);
  return mergeAdsTxt(
    resolved.flatMap(({ source, body }) =>
      body ? [{ name: source.name, body: body.body, fetchedAt: body.fetchedAt }] : []
    )
  );
}

export const getAdsTxt = createTtlMemo(() => buildAdsTxt(), MEMO_TTL_MS);
