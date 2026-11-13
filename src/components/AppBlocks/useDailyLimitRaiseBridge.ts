import { useCallback, useMemo, useRef } from 'react';
import { openDailyLimitRaise } from '~/components/AppBlocks/openDailyLimitRaise';
import { isDailyLimitRefusal } from '~/components/AppBlocks/runConfirmedStepGate';
import { trpc } from '~/utils/trpc';

/** A refusal this host relayed counts as recent for an app's own raise request this long. */
export const RELAYED_REFUSAL_WINDOW_MS = 5 * 60_000;

/**
 * The host side of the in-app daily-limit raise, shared by both hosts.
 *
 * - `onRelayedSnapshot`: a submit this host relayed was refused at the viewer's limit, so offer
 *   the raise dialog (it opens only when the server has a limit to raise).
 * - `onConfirmedStepRefusal`: the confirmed-step preview or submit hit the limit; offer the raise,
 *   or run `fallback` (today's explanation with a link) when there is nothing to raise.
 * - `onRaiseRequest`: the app asked (`REQUEST_DAILY_LIMIT_RAISE`). The dialog opens only after a
 *   refusal this host relayed in the last few minutes, or one the server recorded; the app's
 *   word alone never opens it. `ack(opened)` is sent as soon as that is known, then
 *   `result(raised)` when the dialog closes.
 */
export function useDailyLimitRaiseBridge(opts: {
  appBlockId: string;
  appName?: string | null;
  disabled?: boolean;
}) {
  const { appBlockId, appName, disabled } = opts;
  const utils = trpc.useUtils();
  const lastRelayedRefusalAt = useRef<number | null>(null);
  // A refusal at the old limit must not let the app reopen the dialog after the viewer raised it.
  const offer = useCallback(
    async (
      extra?: Pick<Parameters<typeof openDailyLimitRaise>[0], 'requireServerRefusal' | 'onOpened'>
    ) => {
      const outcome = await openDailyLimitRaise({ utils, appBlockId, appName, ...extra });
      if (outcome === 'raised') lastRelayedRefusalAt.current = null;
      return outcome;
    },
    [utils, appBlockId, appName]
  );

  const onRelayedSnapshot = useCallback(
    (snapshot: unknown) => {
      if (disabled || !isDailyLimitRefusal(snapshot)) return;
      lastRelayedRefusalAt.current = Date.now();
      void offer();
    },
    [disabled, offer]
  );

  const onConfirmedStepRefusal = useCallback(
    (fallback: () => void) => {
      if (disabled) return fallback();
      lastRelayedRefusalAt.current = Date.now();
      void offer().then((outcome) => {
        if (outcome === 'unavailable') fallback();
      });
    },
    [disabled, offer]
  );

  const onRaiseRequest = useCallback(
    async (reply: { ack: (opened: boolean) => void; result: (raised: boolean) => void }) => {
      if (disabled) {
        reply.ack(false);
        reply.result(false);
        return;
      }
      const seen = lastRelayedRefusalAt.current;
      const hostSawRefusal = seen !== null && Date.now() - seen < RELAYED_REFUSAL_WINDOW_MS;
      let opened = false;
      const outcome = await offer({
        requireServerRefusal: !hostSawRefusal,
        onOpened: () => {
          opened = true;
          reply.ack(true);
        },
      });
      if (!opened) reply.ack(false);
      reply.result(outcome === 'raised');
    },
    [disabled, offer]
  );

  return useMemo(
    () => ({ onRelayedSnapshot, onConfirmedStepRefusal, onRaiseRequest }),
    [onRelayedSnapshot, onConfirmedStepRefusal, onRaiseRequest]
  );
}
