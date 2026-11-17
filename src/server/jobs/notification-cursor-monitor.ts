import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('notification-cursor-monitor', 'yellow');

// Cursors that are intentionally inactive; their notification types are
// disabled so a stale cursor here is not a real problem and shouldn't page.
// Confirmed against production state on 2026-05-08; revisit if any of these
// are reactivated.
const IGNORED_CURSORS = new Set([
  'last-sent-notification-join-community',
  'last-sent-notification-image-reaction-milestone',
  'last-sent-notification-new-review',
  'last-sent-notification-model-old-draft',
  'last-sent-notification-review-reminder',
]);

const STALE_THRESHOLD_MIN = 15;
const ESCALATE_THRESHOLD_MIN = 60;

type CursorRow = { key: string; value: unknown };

export const notificationCursorMonitor = createJob(
  'notification-cursor-monitor',
  '*/5 * * * *',
  async () => {
    const rows = await dbRead.$queryRaw<CursorRow[]>`
      SELECT "key", "value"
      FROM "KeyValue"
      WHERE "key" LIKE 'last-sent-notification-%'
    `;

    const nowMs = Date.now();
    const staleThresholdMs = STALE_THRESHOLD_MIN * 60_000;
    const escalateThresholdMs = ESCALATE_THRESHOLD_MIN * 60_000;

    const stale = rows
      .filter((r) => !IGNORED_CURSORS.has(r.key))
      .map((r) => {
        // KeyValue.value is JSONB; cursor entries are stored as numeric ms-since-epoch.
        const ms = typeof r.value === 'number' ? r.value : Number(r.value);
        return { key: r.key, lagMs: Number.isFinite(ms) ? nowMs - ms : 0 };
      })
      .filter((r) => r.lagMs > staleThresholdMs);

    if (stale.length === 0) {
      log('all cursors fresh');
      return;
    }

    for (const r of stale) {
      const lagMinutes = Math.floor(r.lagMs / 60_000);
      const isEscalated = r.lagMs > escalateThresholdMs;
      logToAxiom(
        {
          type: isEscalated ? 'error' : 'warning',
          name: 'Notification cursor stale',
          details: { key: r.key, lagMinutes, escalated: isEscalated },
        },
        'notifications'
      );
    }

    log(`flagged ${stale.length} stale cursors`);
  }
);
