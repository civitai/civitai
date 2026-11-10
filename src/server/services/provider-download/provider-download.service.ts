import type { NextApiRequest, NextApiResponse } from 'next';
import { Tracker } from '~/server/clickhouse/client';
import { countProviderDownload } from '~/server/prom/provider-download.metrics';
import {
  checkGenerationFetch,
  type GenerationFetchRefusal,
  type GenerationFetchSelectors,
} from '~/server/services/download-link/generation-fetch.service';
import { takeProviderDownload } from '~/server/services/provider-download/provider-download.limiter';
import {
  isProviderToken,
  matchProviderToken,
  parseProviderToken,
} from '~/server/services/provider-download/provider-token';
import { getLiveProviderTokens } from '~/server/services/provider-download/provider-token.store';
import { resolveDownloadUrl } from '~/utils/delivery-worker';

export type ProviderTokenParam =
  | { kind: 'none' }
  | { kind: 'duplicate' }
  | { kind: 'provider'; token: string };

/**
 * Reads `?token=` for a per-provider download token. When one is present it is removed from
 * `req.query` and `req.url` before anything else reads the request, so no session code sees it and
 * no log line carries it. A `?token=` without `:` is left alone: it is a user API key.
 */
export function takeProviderToken(req: NextApiRequest): ProviderTokenParam {
  const raw = req.query.token;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (!values.some(isProviderToken)) return { kind: 'none' };

  delete req.query.token;
  if (req.url) {
    const queryAt = req.url.indexOf('?');
    if (queryAt >= 0) {
      const params = new URLSearchParams(req.url.slice(queryAt + 1));
      params.delete('token');
      const rest = params.toString();
      req.url = req.url.slice(0, queryAt) + (rest ? `?${rest}` : '');
    }
  }
  return values.length === 1 ? { kind: 'provider', token: values[0] } : { kind: 'duplicate' };
}

export type ProviderRefusal = { status: number; body: { error: string } };

/**
 * Resolves a provider token to its provider and takes one download from its hourly ceiling. A
 * token that matches no live token is a 401, never an anonymous download.
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
}): Promise<{ ok: true; url: string } | ({ ok: false } & ProviderRefusal)> {
  const check = await checkGenerationFetch({
    modelVersionId,
    fileId,
    principal: { kind: 'provider', provider },
    selectors,
  });
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
  });
  return { ok: true, url };
}
