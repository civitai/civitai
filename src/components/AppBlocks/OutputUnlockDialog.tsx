import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import { useConfirmArmDelay } from '~/components/AppBlocks/GuardedConfirmDialog';
import { useDialogContext, useDialogId } from '~/components/Dialog/DialogProvider';
import { useIsTopDialog } from '~/components/Dialog/dialogStore';
import { outputUnlockRedHref } from '~/components/AppBlocks/outputUnlockLinkOut';
import { useSyncAccount } from '~/hooks/useSyncAccount';
import { useServerDomains } from '~/providers/AppProvider';
import { numberWithCommas } from '~/utils/number-helpers';

/** What the server's `blocks.previewOutputUnlock` said the host may offer. */
export type OutputUnlockOffer =
  | { kind: 'pay'; position: number; unlockBuzz: number }
  | { kind: 'link-out'; position: number; message: string }
  | { kind: 'unavailable'; position: number; message: string };

/** The server's `blocks.unlockOutput` result, as far as the dialog reads it. */
export type OutputUnlockServerResult = {
  outcome: 'unlocked' | 'not-restricted' | 'not-released' | 'refused' | 'unavailable';
  snapshot: unknown;
  message?: string;
};

export type OutputUnlockDialogProps = {
  appName?: string | null;
  offer: OutputUnlockOffer;
  /** Runs the confirmed unlock at the offered total. */
  unlock: (expectedTotal: number) => Promise<OutputUnlockServerResult>;
  /** The server's result, once an unlock returned one. */
  onResult: (result: OutputUnlockServerResult) => void;
  /** The viewer followed the link to civitai.red. */
  onLinkedOut: () => void;
  /** The same app on civitai.red at the host's current sub-path; `null` for no link. */
  linkOut?: { slug: string; subPath: string } | null;
};

/**
 * The host's own dialog for ONE restricted output an app asked to unlock, drawn outside the
 * iframe. Every number comes from the server's preview, never from the app. "Unlock" stays
 * disabled for the arm delay (and while another dialog is on top), so a click aimed at the app
 * cannot land on it; focus starts on "Not now".
 *
 * - `pay`: civitai.com's "Unlock with yellow Buzz", at the orchestrator's price. The app takes
 *   no share of an unlock.
 * - `link-out`: the site this app runs on cannot show it; civitai.red can. The button opens the
 *   SAME app there at the current page (`outputUnlockRedHref`). No charge.
 * - `unavailable`: why it cannot be unlocked (e.g. the viewer's own mature content settings).
 */
export default function OutputUnlockDialog({
  appName,
  offer,
  unlock,
  onResult,
  onLinkedOut,
  linkOut,
}: OutputUnlockDialogProps) {
  const dialog = useDialogContext();
  const isTopMost = useIsTopDialog(useDialogId());
  const armed = useConfirmArmDelay(undefined, isTopMost);
  const redDomain = useServerDomains().red;
  const syncAccount = useSyncAccount();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = sanitizeAppChromeName(appName) ?? 'this app';

  return (
    <Modal
      {...dialog}
      title={`Unlock a result from ${who}`}
      // While an unlock is in flight the dialog cannot be dismissed, so its result always lands.
      closeOnEscape={dialog.closeOnEscape && !pending}
      closeOnClickOutside={!pending}
      withCloseButton={!pending}
    >
      <Stack gap="sm" data-testid="block-output-unlock">
        {offer.kind === 'pay' && (
          <>
            <Text size="sm">
              This result was generated with Buzz that cannot be used for mature content. Unlock it
              with yellow Buzz, and the Buzz you spent on it is refunded.
            </Text>
            <Text size="sm" fw={700} data-testid="block-output-unlock-price">
              Unlock: {numberWithCommas(offer.unlockBuzz)} yellow Buzz
            </Text>
          </>
        )}
        {offer.kind !== 'pay' && <Text size="sm">{offer.message}</Text>}
        {error && (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        )}
        <Group justify="flex-end">
          <Button
            variant="default"
            onClick={() => dialog.onClose()}
            disabled={pending}
            data-autofocus
          >
            {offer.kind === 'unavailable' ? 'Close' : 'Not now'}
          </Button>
          {offer.kind === 'link-out' && redDomain && linkOut && (
            <Button
              component="a"
              href={syncAccount(outputUnlockRedHref({ redDomain, ...linkOut }))}
              target="_blank"
              rel="noreferrer nofollow"
              color="red"
              onClick={() => {
                onLinkedOut();
                dialog.onClose();
              }}
              data-testid="block-output-unlock-link-out"
            >
              Open on civitai.red
            </Button>
          )}
          {offer.kind === 'pay' && (
            <Button
              color="yellow"
              disabled={!armed}
              loading={pending}
              onClick={async () => {
                setError(null);
                setPending(true);
                try {
                  const result = await unlock(offer.unlockBuzz);
                  onResult(result);
                  if (
                    result.outcome === 'refused' ||
                    result.outcome === 'not-released' ||
                    result.outcome === 'unavailable'
                  ) {
                    // The server says why (for not-released: the unlock went through, but the
                    // output is rated above the viewer's level).
                    setError(
                      result.message ??
                        'This result is still above your browsing level, so it stays hidden.'
                    );
                  } else {
                    dialog.onClose();
                  }
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'The unlock failed.');
                } finally {
                  setPending(false);
                }
              }}
              data-testid="block-output-unlock-confirm"
            >
              Unlock for {numberWithCommas(offer.unlockBuzz)}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
