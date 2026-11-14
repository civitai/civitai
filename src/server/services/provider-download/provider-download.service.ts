import type { NextApiRequest, NextApiResponse } from 'next';
import { Tracker } from '~/server/clickhouse/client';
import { countProviderDownload } from '~/server/prom/provider-download.metrics';
import {
  checkGenerationFetch,
  type GenerationFetchRefusal,
  type GenerationFetchResult,
  type GenerationFetchSelectors,
} from '~/server/services/download-link/generation-fetch.service';
import { takeProviderDownload } from '~/server/services/provider-download/provider-download.limiter';
import {
  matchProviderToken,
  parseProviderToken,
} from '~/server/services/provider-download/provider-token';
import { getLiveProviderTokens } from '~/server/services/provider-download/provider-token.store';
import { resolveDownloadUrl } from '~/utils/delivery-worker';

export type ProviderRefusal = { status: number; body: { error: string } };

/**
 * Resolves a provider token to its provider and takes one download from its hourly ceiling. A
 * token that matches no live token is a 401, never an anonymous download.
 *
 * The ceiling is taken before the version and file are checked, so it counts every request on a
 * valid token, including those then refused (not found, in review).
 */
export async function authorizeProviderToken(
  token: string
): Promise<{ ok: true; provider: string } | ({ ok: false } & ProviderRefusal)> {
  let live;
  try {
    live = await getLiveProviderTokens();
  } catch {
    return { ok: false, status: 503, body: { error: 'provider tokens unavailable' } };
  }
  const match = matchProviderToken(token, live);
  if (!match) {
    const named = parseProviderToken(token)?.provider;
    const label = named && live.some((entry) => entry.provider === named) ? named : 'unknown';
    countProviderDownload(label, 'refused_401', 'unknown');
    return { ok: false, status: 401, body: { error: 'invalid provider token' } };
  }
  if (!(await takeProviderDownload(match.provider, match.hourlyCeiling))) {
    countProviderDownload(match.provider, 'refused_429', 'unknown');
    return { ok: false, status: 429, body: { error: 'provider download limit reached' } };
  }
  return { ok: true, provider: match.provider };
}

const REFUSAL_STATUS: Record<GenerationFetchRefusal, number> = {
  'not-found': 404,
  'no-access': 403,
  'no-generation': 403,
  'early-access': 403,
  archived: 410,
  'failed-scan': 403,
  poi: 403,
  unauthorized: 403,
  'in-review': 403,
  'unsupported-file': 400,
};

export type ProviderServed = { ok: true; url: string } | ({ ok: false } & ProviderRefusal);

/**
 * The file a provider asked for, as a short-lived URL, recorded as a `GenerationFetch` carrying
 * the provider. Never resolves a session.
 */
export async function serveProviderDownload({
  req,
  res,
  provider,
  modelVersionId,
  fileId,
  selectors,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
  provider: string;
  modelVersionId: number;
  fileId?: number;
  selectors: GenerationFetchSelectors;
}): Promise<ProviderServed> {
  const check = await checkGenerationFetch({
    modelVersionId,
    fileId,
    principal: { kind: 'provider', provider },
    selectors,
  });
  return serveProviderFetch({ req, res, provider, check });
}

/** Answers a provider principal's `checkGenerationFetch` result, however its file was chosen. */
export async function serveProviderFetch({
  req,
  res,
  provider,
  check,
  expiresInSeconds,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
  provider: string;
  check: GenerationFetchResult;
  /** The signed file URL's lifetime; the delivery worker's default when omitted. */
  expiresInSeconds?: number;
}): Promise<ProviderServed> {
  if (!check.ok) {
    countProviderDownload(provider, 'refused_gate', 'unknown');
    return { ok: false, status: REFUSAL_STATUS[check.error], body: { error: check.error } };
  }
  countProviderDownload(provider, 'granted', check.isPublic ? 'public' : 'nonpublic');

  // `null`: the request has no user, and the tracker must not go looking for one.
  new Tracker(req, res, null)
    .modelVersionEvent({
      type: 'GenerationFetch',
      modelId: check.modelId,
      modelVersionId: check.modelVersionId,
      fileId: check.fileId,
      nsfw: check.nsfw,
      earlyAccess: check.inEarlyAccess,
      provider,
    })
    .catch(() => undefined);

  const { url } = await resolveDownloadUrl(check.fileId, check.fileUrl, check.fileName, {
    caller: 'download-route',
    actor: 'internal',
    expiresInSeconds,
  });
  return { ok: true, url };
}
