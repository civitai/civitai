import { timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { isAppBlocksPipelineEnabled } from '~/server/services/app-blocks-flag';
import {
  BLOCK_WORKFLOW_STATUSES,
  updateBlockWorkflowStatus,
  type BlockWorkflowStatus,
} from '~/server/services/blocks/block-workflows.service';

// H2 (audit-10): cap the orchestrator callback body. Realistic payloads are
// a few hundred bytes (workflowId + blockInstanceId + buzzSpent).
export const config = {
  api: {
    bodyParser: { sizeLimit: '4kb' },
  },
};

// M-6 (audit): idempotency dedup. Phase 3 billing will inherit this scaffold;
// adding the dedup primitive now means the orchestrator can ship retries
// safely from day one. The marker TTL is 7 days — long enough that retries
// can't re-bill a completed workflow.
const WORKFLOW_DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;
async function markWorkflowProcessed(workflowId: string): Promise<boolean> {
  // Uses block rate-limit key family for now (separate Phase 3 key TBD).
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:wf:${workflowId}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, WORKFLOW_DEDUP_TTL_SECONDS);
      return true; // first time seen → process
    }
    return false; // already processed
  } catch {
    // Fail closed: a Redis incident must not let a retry double-bill, so we
    // treat the workflow as already-processed (return false). The handler then
    // responds 200 {ok:true, idempotent:true} and does NOT process/bill it.
    // Trade-off: a 200 means the orchestrator won't redeliver, so the
    // completion is effectively dropped for the duration of the outage. That's
    // acceptable while this is a no-op scaffold (no billing yet); revisit when
    // Phase-3 billing lands — at that point a Redis outage dropping a billable
    // completion may warrant a 5xx-to-force-retry instead.
    return false;
  }
}

function safeEqualHeader(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/internal/blocks/workflow-completed
 *
 * Orchestrator → civitai callback fired when a block-initiated workflow
 * settles. Guards with the JOB_TOKEN shared secret (orchestrator already
 * carries this — see civitai-orchestration billing grain). Phase 3 layers
 * actual developer-revenue attribution and ClickHouse `block_workflows`
 * emission on top of this scaffold.
 *
 * L12 kill switch: the Flipt flag `app-blocks-pipeline-enabled` gates this
 * endpoint (Decision 1 — the dedicated pipeline flag, not the mod-segmented
 * user flag). If the orchestrator ships callbacks before Phase 3 billing lands,
 * the flag stays off and we return 503 — no phantom completion records.
 */

const BLOCK_INSTANCE_ID_RE = /^bki_[0-9A-HJKMNP-TV-Z]{26}$/;

const requestSchema = z.object({
  workflowId: z.string().min(1).max(64),
  blockInstanceId: z.string().regex(BLOCK_INSTANCE_ID_RE, 'expected bki_<26 Crockford base32>'),
  buzzSpent: z.number().int().nonnegative().max(1_000_000),
  modelId: z.number().int().positive().optional(),
  // G6 — the terminal status the workflow settled to, for the persistent block
  // output queue read-model. Optional: a settle callback that omits it defaults
  // to 'succeeded' (the callback fires on completion). The block-contract status
  // set, matching the block_workflows CHECK constraint.
  status: z
    .enum(BLOCK_WORKFLOW_STATUSES as unknown as [BlockWorkflowStatus, ...BlockWorkflowStatus[]])
    .optional(),
});

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!env.JOB_TOKEN || !safeEqualHeader(req.headers['x-civitai-internal-token'], env.JOB_TOKEN)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }
  const { blockInstanceId, workflowId } = parsed.data;
  // A settle callback that omits the status defaults to 'succeeded' (the callback
  // fires on completion).
  const status: BlockWorkflowStatus = parsed.data.status ?? 'succeeded';

  // Audit-9 #6: validate the install BEFORE writing the 7-day dedup marker.
  // A malformed/wrong workflowId paired with a bogus blockInstanceId would
  // otherwise burn a Redis slot for a week, even though we know on the
  // first call the request is invalid.
  //
  // Post kill_per_model_installs: per-model installs ARE block_user
  // _subscription rows now. block_instance_id is UNIQUE on subscriptions
  // for pinned rows (the migrated install row carries its old bki_*).
  const install = await dbRead.blockUserSubscription.findUnique({
    where: { blockInstanceId },
    select: { id: true, targetModelIds: true, appBlockId: true },
  });
  if (!install || !install.targetModelIds || install.targetModelIds.length === 0) {
    res.status(404).json({ error: 'Block install not found' });
    return;
  }

  // M-6: idempotency gate. Retries (orchestrator network blips, at-least-once
  // delivery) hit this and short-circuit with 200 — but only the first
  // delivery proceeds to the billing path.
  //
  // M6 (audit-10): the dedup is keyed on workflowId alone. The orchestrator
  // is currently trusted (JOB_TOKEN) to send a valid (workflowId,
  // blockInstanceId) pair, but Phase 3 billing must add a cross-check
  // that this workflow was actually initiated by this block instance.
  // Required before Phase 3 ships — flagging here so the billing PR
  // can't land without binding the pair (e.g., orchestrator emits a
  // tamper-resistant signature over the pair, or we record the
  // (workflowId, blockInstanceId) at workflow-create time and verify
  // on completion).
  const firstTime = await markWorkflowProcessed(workflowId);
  if (!firstTime) {
    res.status(200).json({ ok: true, idempotent: true });
    return;
  }

  // G6 — persist the terminal status into the block_workflows read-model so a
  // block can rebuild its output queue on load. UN-GATED by the pipeline flag:
  // this is the queue read-model, NOT billing (no money, no ClickHouse). Keeping
  // the JOB_TOKEN guard + 7-day idempotency above. Best-effort + fail-safe
  // (updateBlockWorkflowStatus never throws): a lost update degrades to a stale
  // status hint — the block can always poll the orchestrator for the live status
  // — so this stays a no-throw 200 path. A 0-row update (no matching row: the
  // submit-time write was lost, or this is a non-block workflow) is a silent
  // no-op.
  await updateBlockWorkflowStatus({ workflowId, status });

  // L12 kill switch (Phase 3 BILLING only): the dedicated global
  // `app-blocks-pipeline-enabled` flag gates the FUTURE developer-revenue
  // attribution + ClickHouse `block_workflows` emission. It NO LONGER gates the
  // queue read-model status update above (that is not billing). The billing path
  // is still a scaffold (no-op) — when it lands, prefer giving it its OWN flag
  // (e.g. `app-blocks-billing-enabled`) rather than the build flag.
  //
  // L13 (audit log): install/uninstall/settings-change/manifest-upsert audit
  // logging is a Phase 3 line item, alongside the ClickHouse work.
  const billingEnabled = await isAppBlocksPipelineEnabled();
  if (billingEnabled) {
    // Phase 3: ClickHouse insert + developer-revenue attribution lands here.
  }

  res.status(200).json({ ok: true });
});
