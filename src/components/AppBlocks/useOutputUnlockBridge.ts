import dynamic from 'next/dynamic';
import { useCallback, useMemo } from 'react';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import type {
  OutputUnlockOffer,
  OutputUnlockServerResult,
} from '~/components/AppBlocks/OutputUnlockDialog';
import { trpc } from '~/utils/trpc';

const OutputUnlockDialog = dynamic(() => import('./OutputUnlockDialog'), { ssr: false });

/**
 * What the app learns from REQUEST_OUTPUT_UNLOCK (`OUTPUT_UNLOCK_RESULT { result }`):
 *   - `unlocked`: the output now has a url; `snapshot` is the re-read workflow.
 *   - `not-restricted`: it already had one; nothing was shown or charged.
 *   - `not-released`: the unlock ran but the output is still above the viewer's level;
 *     `message` says why.
 *   - `unavailable` after a confirm: the orchestrator write got no response and may still land;
 *     `message` says to check back.
 *   - `refused`: the orchestrator refused the yellow charge (Yellow balance short); `message` says so.
 *   - `linked-out`: the viewer opened civitai.red to see it. Never charged.
 *   - `dismissed`: the viewer closed the dialog.
 *   - `unavailable`: it cannot be unlocked here; `message` says why.
 */
export type OutputUnlockBridgeResult =
  | { outcome: 'unlocked'; snapshot: unknown }
  | { outcome: 'not-released'; snapshot: unknown; message?: string }
  | { outcome: 'refused'; snapshot: unknown; message: string }
  | { outcome: 'not-restricted' | 'linked-out' | 'dismissed' }
  | { outcome: 'unavailable'; message: string };

function errorMessage(e: unknown) {
  return e instanceof Error && e.message ? e.message : 'This output cannot be unlocked right now.';
}

/**
 * The host side of REQUEST_OUTPUT_UNLOCK, shared by both hosts. The app names a workflow and an
 * output POSITION; the server decides what may be offered (`blocks.previewOutputUnlock`) and the
 * host draws it. Only a click in the host's dialog spends (`blocks.unlockOutput`), at the total
 * that dialog showed.
 */
export function useOutputUnlockBridge(opts: {
  appName?: string | null;
  disabled?: boolean;
  /**
   * The app's run slug and the host's current sub-path, for a `link-out` to the same app on
   * civitai.red (`outputUnlockRedHref`). From the host's own route, never from the app. `null`
   * where the host has no run page to link to (the model slot): the dialog then explains only.
   */
  linkOut?: { slug: string; subPath: string } | null;
}) {
  const { appName, disabled } = opts;
  const linkOutSlug = opts.linkOut?.slug;
  const linkOutSubPath = opts.linkOut?.subPath;
  // Reached through the vanilla client on request, never at render: every host suite's trpc mock
  // would otherwise need two more procedures for the host to render at all.
  const utils = trpc.useUtils();

  const onUnlockRequest = useCallback(
    async (
      req: { blockToken: string; workflowId: string; position: number },
      reply: (result: OutputUnlockBridgeResult) => void
    ) => {
      if (disabled) {
        reply({ outcome: 'unavailable', message: 'Unlocking is not available here.' });
        return;
      }
      let offer: Awaited<ReturnType<typeof utils.client.blocks.previewOutputUnlock.mutate>>;
      try {
        offer = await utils.client.blocks.previewOutputUnlock.mutate(req);
      } catch (e) {
        reply({ outcome: 'unavailable', message: errorMessage(e) });
        return;
      }
      if (offer.kind === 'not-restricted') {
        reply({ outcome: 'not-restricted' });
        return;
      }
      const id = `block-output-unlock-${req.workflowId}-${req.position}`;
      if (useDialogStore.getState().dialogs.some((d) => d.id === id)) {
        reply({ outcome: 'unavailable', message: 'This output is already being unlocked.' });
        return;
      }
      let last: OutputUnlockServerResult | null = null;
      let linkedOut = false;
      dialogStore.trigger({
        id,
        component: OutputUnlockDialog,
        props: {
          appName,
          offer: offer as OutputUnlockOffer,
          linkOut:
            linkOutSlug !== undefined ? { slug: linkOutSlug, subPath: linkOutSubPath ?? '' } : null,
          unlock: (expectedTotal: number) =>
            utils.client.blocks.unlockOutput.mutate({
              ...req,
              expectedTotal,
            }) as Promise<OutputUnlockServerResult>,
          onResult: (result: OutputUnlockServerResult) => {
            last = result;
          },
          onLinkedOut: () => {
            linkedOut = true;
          },
        },
        options: {
          onClose: () => {
            const result = last as OutputUnlockServerResult | null;
            if (linkedOut) reply({ outcome: 'linked-out' });
            else if (!result) {
              reply(
                offer.kind === 'unavailable'
                  ? { outcome: 'unavailable', message: offer.message }
                  : { outcome: 'dismissed' }
              );
            } else if (result.outcome === 'refused') {
              reply({
                outcome: 'refused',
                snapshot: result.snapshot,
                message:
                  result.message ?? 'You do not have enough yellow Buzz to unlock this output.',
              });
            } else if (result.outcome === 'not-restricted') {
              reply({ outcome: 'not-restricted' });
            } else if (result.outcome === 'not-released') {
              reply({
                outcome: 'not-released',
                snapshot: result.snapshot,
                ...(result.message ? { message: result.message } : {}),
              });
            } else if (result.outcome === 'unavailable') {
              reply({
                outcome: 'unavailable',
                message: result.message ?? 'This output cannot be unlocked right now.',
              });
            } else {
              reply({ outcome: 'unlocked', snapshot: result.snapshot });
            }
          },
        },
      });
    },
    [disabled, appName, utils, linkOutSlug, linkOutSubPath]
  );

  return useMemo(() => ({ onUnlockRequest }), [onUnlockRequest]);
}
