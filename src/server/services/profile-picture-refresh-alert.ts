import { notifyModAlert } from '~/server/common/mod-alert';

export const REFRESH_ALERT_WINDOW_MS = 10 * 60 * 1000;

type Send = (step: string, failures: number) => unknown;

const sendModAlert: Send = (step, failures) =>
  notifyModAlert(
    'Profile picture refresh step failing',
    `Step \`${step}\` failed ${failures} time(s) since its last alert. Avatars can stay stale until the cache expires; details are in the profile-picture-cache-refresh logs.`,
    { noMentions: true }
  );

/**
 * A reporter for failed profile-picture refresh steps: alerts the moderator channel at most once per
 * step per `windowMs` in this process, with the step name and how many failures it has seen since
 * its last alert, never user ids. Limited in process rather than through Redis, which can be the
 * failing step. The alert is not awaited and never throws, so it can neither slow nor fail the step.
 */
export function createRefreshStepAlert({
  send = sendModAlert,
  now = Date.now,
  windowMs = REFRESH_ALERT_WINDOW_MS,
  onError = () => undefined,
}: {
  send?: Send;
  now?: () => number;
  windowMs?: number;
  onError?: (error: unknown) => void;
} = {}) {
  const lastAlertAt = new Map<string, number>();
  const failuresSince = new Map<string, number>();
  return (step: string) => {
    const failures = (failuresSince.get(step) ?? 0) + 1;
    failuresSince.set(step, failures);
    const at = now();
    const last = lastAlertAt.get(step);
    if (last !== undefined && at - last < windowMs) return;
    lastAlertAt.set(step, at);
    failuresSince.set(step, 0);
    // An undelivered alert is dropped: the step's own log already has the failure.
    let sent: unknown;
    try {
      sent = send(step, failures);
    } catch (error) {
      onError(error);
      return;
    }
    void Promise.resolve(sent).catch(onError);
  };
}

export const alertRefreshStepFailure = createRefreshStepAlert();
