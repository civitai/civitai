/**
 * Debug endpoint for exercising the full XGuard pipeline end-to-end:
 * orchestrator submit → wait → audit-write to scanner_label_results.
 *
 * GET /api/admin/test?token=$WEBHOOK_TOKEN
 *
 * Submits a scan via `createXGuardModerationRequest` with `recordForReview:
 * true`, waits up to 60s for the orchestrator, and pushes the workflow
 * through `recordXGuardScanFromWorkflow` — the same helper the webhook
 * callback uses. No entity is attached, so the entity-moderation path is
 * skipped; only the audit-write (ClickHouse) runs.
 *
 * Edit the constants below to change what gets scanned. `LABELS` is passed
 * through as the orchestrator evaluation filter; leave the array empty to
 * let the orchestrator evaluate every label it has configured.
 */
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { recordXGuardScanFromWorkflow } from '~/server/services/scanner-audit.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const POSITIVE_PROMPT = ``;
const NEGATIVE_PROMPT = '';
const TEXT = `{"anal beads","anal tail","artificial vagina",tenga,"butt plug",aneros,"butt plug tail","cock ring",dildo,"double dildo","huge dildo","dragon dildo","horse dildo","spiked dildo",strap-on,"suction cup dildo","dildo riding","food insertion","dildo gag","mask challenge (meme)","dildo harness","dildo under panties","prostate massager",Pump,"breast pump","clitoris pump","sex machine","too many sex toys",sounding,catheter,"urethral beads",vibrator,"bunny vibrator","butterfly vibrator","egg vibrator","hitachi magic wand","remote control vibrator","riding machine",sybian,"public vibrator","vibrator in anus"}`;
const LABELS: string[] = ['csam', 'pg', 'pg13', 'r', 'x', 'xxx']; // empty array = evaluate every label the orchestrator knows about

export default WebhookEndpoint(async (req, res) => {
  const workflow = await createXGuardModerationRequest({
    mode: 'text',
    content: TEXT,
    labels: LABELS.length > 0 ? LABELS : undefined,
    recordForReview: true,
    wait: 60,
    // Suppress the auto-callback — this endpoint waits synchronously and
    // calls `recordXGuardScanFromWorkflow` itself just below, so a callback
    // would just produce a duplicate (idempotent but wasteful) insert.
    callbackUrl: null,
  });

  if (!workflow) {
    res.status(500).json({ status: 'orchestrator-error' });
    return;
  }

  // Mirror the callback URL handler — push the synchronously-returned
  // workflow through the same audit-write path the webhook would use.
  await recordXGuardScanFromWorkflow(workflow);

  res.status(200).json({ workflow });
});
