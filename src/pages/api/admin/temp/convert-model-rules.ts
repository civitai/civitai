/**
 * One-time conversion of regex Model moderation rules to plain-language rules.
 * =============================================================================
 *
 * Hidden admin route. Guarded by the WEBHOOK_TOKEN via `?token=` query param
 * (see WebhookEndpoint). Not reachable without the secret; no public UI.
 *
 * Background:
 *   The ModelRules text scan reads semantic rules (subject, description, aliases).
 *   Model rules written before it are regex; nothing can create one any more, so
 *   this converts the leftovers in place, once per environment. Run `count`, then
 *   `apply`. Rows keep their ids and their regex as `legacyMatch`. A rule that
 *   does not reduce to plain text (a pattern, an `and`, a tag or property
 *   condition) or whose action was Approve is converted disabled and flagged
 *   `needsAttention` until a moderator rewrites it in the moderator app. Every
 *   converted rule ends with action Block.
 *
 * Usage:
 *   POST /api/admin/temp/convert-model-rules?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>" }
 *
 * Actions:
 *   count   - Dry run: how many regex rules are left, how many convert cleanly and
 *             how many would be flagged and disabled. No writes.
 *   apply   - Convert them, then clear the Model rules cache. Idempotent: a second
 *             run finds nothing to convert, and a partial run is finished by re-running.
 *
 * Responses carry counts only, never rule text.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import {
  convertLegacyModelRules,
  countLegacyModelRules,
} from '~/server/services/text-scan/model-rules-convert';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ action: z.enum(['count', 'apply']) });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }

  if (payload.data.action === 'count') {
    return res.status(200).json({ action: 'count', ...(await countLegacyModelRules()) });
  }

  const result = await convertLegacyModelRules();
  await logToAxiom({
    type: 'info',
    name: 'model-rules-convert',
    message: 'converted regex Model rules',
    ...result,
  }).catch(() => null);
  return res.status(200).json({ action: 'apply', ...result });
});
