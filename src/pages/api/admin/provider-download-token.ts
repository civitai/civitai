import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  PROVIDER_NAME_RE,
  generateProviderSecret,
  generateProviderTokenId,
  hashProviderSecret,
  type ProviderTokenRecord,
} from '~/server/services/provider-download/provider-token';
import { updateProviderTokenRecords } from '~/server/services/provider-download/provider-token.store';
import { HeaderTokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';
import { distinctAdminToken } from '~/server/utils/admin-token';

/**
 * Mints, retires and unretires per-provider download tokens, and sets a provider's hourly ceiling.
 * A minted token is returned once, in the mint response, and never again. Each change reaches the
 * download routes at once through the shared cache; if that cache write fails, once the cached entry
 * goes stale, normally within a minute (provider-token.store.ts).
 */

const SYSTEM_ACTOR_ID = -1;

const actorUserId = z.preprocess(
  (v) => (v === null || v === '' ? undefined : v),
  z.coerce.number().int().positive()
);
const provider = z.string().regex(PROVIDER_NAME_RE);
const MAX_HOURLY_CEILING = 1_000_000;
const hourlyCeiling = z.coerce.number().int().positive().max(MAX_HOURLY_CEILING);

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), actorUserId }),
  z.object({ action: z.literal('mint'), provider, hourlyCeiling, actorUserId }),
  z.object({
    action: z.literal('retire'),
    id: z.string().min(1),
    reason: z.enum(['permanent', 'planned']),
    actorUserId,
  }),
  z.object({ action: z.literal('unretire'), id: z.string().min(1), actorUserId }),
  z.object({ action: z.literal('ceiling'), provider, hourlyCeiling, actorUserId }),
]);

/** A record as the admin sees it: everything but the hash. */
const describe = ({ hash: _hash, ...record }: ProviderTokenRecord) => record;

export default HeaderTokenSecuredEndpoint(
  () => distinctAdminToken('PROVIDER_DOWNLOAD_TOKEN_ADMIN_TOKEN'),
  async function (req: AxiomAPIRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
    const input = parsed.data;
    const now = new Date().toISOString();
    let secret: string | undefined;

    const outcome = await updateProviderTokenRecords<unknown>((records, registered) => {
      switch (input.action) {
        case 'list':
          return { result: records.map(describe) };
        case 'mint': {
          if (!registered.has(input.provider))
            return { error: `unknown provider ${input.provider}: no worker client uses it` };
          secret = generateProviderSecret();
          const record: ProviderTokenRecord = {
            id: generateProviderTokenId(),
            provider: input.provider,
            hash: hashProviderSecret(secret),
            mintedAt: now,
            retiredAt: null,
            retiredFor: null,
            hourlyCeiling: input.hourlyCeiling,
          };
          return { records: [...records, record], result: describe(record) };
        }
        case 'retire':
        case 'unretire': {
          const target = records.find((record) => record.id === input.id);
          if (!target) return { error: `no token ${input.id}` };
          if (input.action === 'unretire' && target.retiredFor === 'permanent')
            return { error: 'a token retired permanently cannot be unretired; mint a new one' };
          const changed: ProviderTokenRecord =
            input.action === 'retire'
              ? {
                  ...target,
                  retiredAt: target.retiredAt ?? now,
                  // Permanent stays permanent: retiring again as planned never makes it unretirable.
                  retiredFor: target.retiredFor === 'permanent' ? 'permanent' : input.reason,
                }
              : { ...target, retiredAt: null, retiredFor: null };
          return {
            records: records.map((record) => (record.id === target.id ? changed : record)),
            result: describe(changed),
          };
        }
        case 'ceiling': {
          if (!records.some((record) => record.provider === input.provider))
            return { error: `no token for ${input.provider}` };
          const next = records.map((record) =>
            record.provider === input.provider
              ? { ...record, hourlyCeiling: input.hourlyCeiling }
              : record
          );
          return {
            records: next,
            result: next.filter((record) => record.provider === input.provider).map(describe),
          };
        }
      }
    });
    if ('error' in outcome) return res.status(400).json({ error: outcome.error });

    if (input.action !== 'list') {
      const subject = 'provider' in input ? input.provider : input.id;
      // Recorded as the system, as system-account-api-key does: `actorUserId` is asserted by the
      // caller, so it goes in the log line, not in the audit row's actor.
      const auditRecorded = await trackModActivity(SYSTEM_ACTOR_ID, {
        entityType: 'user',
        activity: `providerDownloadToken:${input.action}:${subject}`,
      })
        .then(() => true)
        .catch(() => false);
      logToAxiom({
        type: auditRecorded ? 'info' : 'error',
        name: 'provider-download-token-admin',
        details: {
          action: input.action,
          subject,
          asserted_actor: input.actorUserId,
          auditRecorded,
        },
      }).catch(() => null);
    }

    return res.status(200).json(
      secret
        ? {
            ...(outcome.result as object),
            token: `${(outcome.result as ProviderTokenRecord).provider}:${secret}`,
          }
        : outcome.result
    );
  }
);
