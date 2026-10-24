import { registerGauge, registerGaugeWithLabels } from '@civitai/telemetry/client';
import { notifyModAlert } from '~/server/common/mod-alert';
import { dbWrite } from '~/server/db/client';
import { pgDbReadLong } from '~/server/db/pgDb';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import {
  parityReport,
  parityVerdict,
  rowTotals,
  unmirroredReport,
} from '~/server/services/comment-v3-backfill.service';

const KEY = 'comment-v3-parity:last';
const finding = registerGaugeWithLabels({
  name: 'comment_v3_parity_finding',
  help: 'Rows the CommentV3 parity report flagged, per finding, as of the last completed run',
  labelNames: ['finding'] as const,
});
const lastSuccess = registerGauge({
  name: 'comment_v3_parity_last_success_seconds',
  help: 'Unix time the CommentV3 parity job last completed; the finding gauges are stale past a day',
});

export const commentV3ParityJob = createJob(
  'comment-v3-parity',
  '20 9 * * *',
  async () => {
    try {
      const [unmirrored, parity, rows] = await Promise.all([
        unmirroredReport(pgDbReadLong),
        parityReport(pgDbReadLong),
        rowTotals(pgDbReadLong),
      ]);
      const verdict = parityVerdict(unmirrored, parity);
      for (const [name, f] of Object.entries({ ...unmirrored, ...parity })) {
        finding.set({ finding: name }, f.count);
      }
      const result = {
        day: new Date().toISOString().slice(0, 10),
        rows,
        pages: verdict.pages,
        expected: verdict.expected,
        findings: Object.fromEntries(
          Object.entries({ ...unmirrored, ...parity })
            .filter(([, f]) => f.count)
            .map(([k, f]) => [k, f])
        ),
      };

      // The page goes first: a failure writing the record must not swallow the drift.
      const outcome = verdict.pages.length
        ? await notifyModAlert(
            `🚨 CommentV3 parity — ${verdict.pages.length} finding(s) drifted`,
            verdict.pages.map((p) => `**${p}**`).join('\n\n')
          )
        : null;
      // Only a rejected page is a fault; an unconfigured webhook is dev and preview.
      if (outcome === 'rejected')
        await logToAxiom({
          type: 'warning',
          name: 'comment-v3-parity',
          message: 'Discord rejected the page — the drift below reached nobody',
          details: result,
        }).catch(() => null);

      await dbWrite.keyValue.upsert({
        where: { key: KEY },
        create: { key: KEY, value: result },
        update: { value: result },
      });
      await logToAxiom({
        type: verdict.pages.length ? 'warning' : 'info',
        name: 'comment-v3-parity',
        message: verdict.pages.length ? verdict.pages.join(' | ') : 'parity holds',
        details: result,
      }).catch(() => null);
      lastSuccess.set(Date.now() / 1000);
      return outcome === null
        ? { healthy: true, ...result }
        : { healthy: false, paged: outcome === 'delivered', ...result };
    } catch (e) {
      // A monitor that fails quietly reads as healthy: say so where the drift would have gone.
      await notifyModAlert('🚨 CommentV3 parity job failed', (e as Error).message).catch(
        () => null
      );
      throw e;
    }
  },
  { lockExpiration: 30 * 60, keepLockOnDisconnect: true }
);
