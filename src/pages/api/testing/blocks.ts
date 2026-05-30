/**
 * Debug endpoint for app-block installs. WEBHOOK_TOKEN-gated.
 *
 * Until a publisher-facing install UI ships, this is the recommended way
 * to set per-install settings (e.g. the default Checkpoint a LoRA install
 * uses). Scope every action to a single blockInstanceId so misuse can't
 * cascade.
 *
 * Actions:
 *   set-default-checkpoint  - { blockInstanceId, checkpointVersionId|null }
 *       Updates the publisher's default_checkpoint_version_id on the
 *       install's settings JSON. Passes the ecosystem-match + Checkpoint-
 *       type validation gates. Setting null clears the field.
 *
 *   set-buzz-budget        - { blockInstanceId, buzzBudgetPerGen }
 *       Updates the publisher's buzz_budget_per_gen cap (max 1000, per
 *       BlockTokenService).
 *
 *   show                   - { blockInstanceId }
 *       Returns the install row's settings JSON. Read-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set-default-checkpoint'),
    blockInstanceId: z.string().min(1).max(64),
    checkpointVersionId: z.coerce.number().int().positive().nullable(),
  }),
  z.object({
    action: z.literal('set-buzz-budget'),
    blockInstanceId: z.string().min(1).max(64),
    buzzBudgetPerGen: z.coerce.number().int().min(1).max(1000),
  }),
  z.object({
    action: z.literal('show'),
    blockInstanceId: z.string().min(1).max(64),
  }),
]);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
  }
  const input = parsed.data;

  // All actions need the install row (for modelId pinning in updateSettings
  // and for `show`). Single fetch up front.
  //
  // Post kill_per_model_installs: per-model installs ARE block_user
  // _subscription rows now. block_instance_id is UNIQUE on subscriptions
  // for pinned rows.
  const install = await dbWrite.blockUserSubscription.findUnique({
    where: { blockInstanceId: input.blockInstanceId },
    select: {
      targetModelIds: true,
      settings: true,
      appBlock: { select: { blockId: true } },
    },
  });
  if (!install) return res.status(404).json({ error: 'install not found' });
  const modelId = install.targetModelIds?.[0];
  if (!modelId) return res.status(404).json({ error: 'install not found' });

  if (input.action === 'show') {
    return res.status(200).json({ ok: true, settings: install.settings, modelId });
  }

  const current = (install.settings ?? {}) as Record<string, unknown>;
  let nextSettings: Record<string, unknown>;

  if (input.action === 'set-default-checkpoint') {
    nextSettings =
      input.checkpointVersionId === null
        ? Object.fromEntries(
            Object.entries(current).filter(([k]) => k !== 'default_checkpoint_version_id')
          )
        : { ...current, default_checkpoint_version_id: input.checkpointVersionId };
  } else {
    // set-buzz-budget
    nextSettings = { ...current, buzz_budget_per_gen: input.buzzBudgetPerGen };
  }

  try {
    // Route through the registry method so the per-block-id validation
    // (ecosystem match, Published, Checkpoint-type) runs the same way as
    // the future author UI will.
    await BlockRegistry.updateSettings({
      blockInstanceId: input.blockInstanceId,
      modelId,
      settings: nextSettings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'update failed';
    return res.status(400).json({ error: message });
  }
  return res.status(200).json({ ok: true, settings: nextSettings });
}

export default WebhookEndpoint(handler);
