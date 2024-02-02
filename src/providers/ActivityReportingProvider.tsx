import { ReactNode } from 'react';

const SEND_INTERVAL = 10000;
const activities: string[] = [];
async function sendActivities() {
  if (activities.length) {
    await fetch('/api/internal/activity', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ activities }),
    });
    activities.length = 0;
  }
  setTimeout(sendActivities, SEND_INTERVAL);
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
          activities.push(el.dataset.activity);
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
