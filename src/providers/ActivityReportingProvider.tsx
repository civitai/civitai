import type { ReactNode } from 'react';
import { ACTIVITY_CLIENT_BATCH_SIZE } from '~/shared/constants/activity-reporting.constants';

const SEND_INTERVAL = 10000;
const activities: string[] = [];

/** Exported for tests only: the click handler is the one production caller. */
export function queueActivity(activity: string) {
  activities.push(activity);
}

/** Exported for tests only: production starts it once from `init`. */
export async function sendActivities() {
  try {
    // The server refuses a batch over ACTIVITY_BATCH_MAX whole, so a large buffer goes out in
    // chunks. Each chunk is taken off the buffer BEFORE its request, so a click recorded while a
    // request is in flight stays queued for the next one instead of being cleared with it.
    while (activities.length) {
      const batch = activities.splice(0, ACTIVITY_CLIENT_BATCH_SIZE);
      await fetch('/api/internal/activity', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ activities: batch }),
      });
    }
  } catch {
    // Best-effort analytics: a failed send drops its chunk. The finally below keeps the loop alive.
  } finally {
    setTimeout(sendActivities, SEND_INTERVAL);
  }
}

let initialized = false;
function init() {
  // Only run on client
  if (typeof window === 'undefined') return;
  // Only run once
  if (initialized) return;

  document.addEventListener(
    'click',
    (e) => {
      // Scan self and parent for data-activity="..." attribute
      let el = e.target as HTMLElement | null;
      while (el) {
        if (el.dataset.activity) {
          queueActivity(el.dataset.activity);
          return;
        }
        el = el.parentElement;
      }
    },
    true // Capture phase
  );

  sendActivities();
  initialized = true;
}

export function ActivityReportingProvider({ children }: { children: ReactNode }) {
  init();
  return <>{children}</>;
}
