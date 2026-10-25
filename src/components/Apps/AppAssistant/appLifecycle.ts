import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';

/** When the user last worked on an app (else when it was made), in ms; 0 when neither is known. */
export function lastUsedAt(sandbox: Sandbox): number {
  return Date.parse(sandbox.lastActivityAt ?? sandbox.createdAt ?? '') || 0;
}

/** The app the user worked on last, to open on a visit with none open; none when no app says when. */
export function mostRecentApp(apps: Sandbox[]): Sandbox | null {
  return apps.reduce<Sandbox | null>(
    (best, s) => (lastUsedAt(s) > (best ? lastUsedAt(best) : 0) ? s : best),
    null
  );
}

/** The app used longest ago that is not open now: what the free-a-slot card offers to delete first. */
export function oldestInactiveApp(apps: Sandbox[], openName: string | null): Sandbox | null {
  return apps.reduce<Sandbox | null>(
    (oldest, s) =>
      s.name !== openName && (!oldest || lastUsedAt(s) < lastUsedAt(oldest)) ? s : oldest,
    null
  );
}
