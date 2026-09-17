import { Button, Modal, Stack, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { formatDownloadEta } from '~/components/ResourceLoad/download-eta';
import { DownloadEtaCompare } from '~/components/ResourceLoad/DownloadEtaCompare';
import { BOOST_LANE_LABEL, DownloadLanesInfo } from '~/components/ResourceLoad/download-lanes';
import type { DownloadPreparation } from '~/shared/orchestrator/download-preparation';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';

export type DownloadBoostChoice = 'boost' | 'continue';

function DownloadBoostConfirmModal({
  preparation,
  boostFee,
  onResolve,
}: {
  preparation: DownloadPreparation;
  boostFee: number | null;
  onResolve: (choice: DownloadBoostChoice | null) => void;
}) {
  const dialog = useDialogContext();
  const { etaSeconds, boostedEtaSeconds, lane, resources } = preparation;
  const count = resources.length;
  const totalBytes = resources.reduce((sum, r) => sum + r.sizeBytes, 0);

  const choose = (choice: DownloadBoostChoice | null) => {
    onResolve(choice);
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      onClose={() => choose(null)}
      title="Download needed first"
      size="sm"
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          {count === 1 ? 'A resource needs' : `${count} resources need`} to download before this
          generation can start — {formatBytes(totalBytes)}.
          {etaSeconds != null && ` Ready in ${formatDownloadEta(etaSeconds)}.`}
        </Text>

        {etaSeconds != null && boostedEtaSeconds != null && (
          <DownloadEtaCompare etaSeconds={etaSeconds} boostedEtaSeconds={boostedEtaSeconds} />
        )}

        <div className="flex items-center gap-2">
          <Text size="xs" c="dimmed">
            {lane === 'low' ? 'Skip the free lane' : 'Skip the queue'} — boosting moves{' '}
            {count === 1 ? 'this download' : 'these downloads'} into {BOOST_LANE_LABEL}.
          </Text>
          <DownloadLanesInfo
            placement={{
              lane,
              queuePosition: preparation.queuePosition,
              transferring: preparation.progress != null,
              etaSeconds,
              boostedEtaSeconds,
              rateLimitBytesPerSecond: preparation.rateLimitBytesPerSecond,
              totalBytes,
              boostFee,
            }}
          />
        </div>

        <Stack gap={8}>
          <Button
            color="yellow"
            leftSection={<IconBolt size={16} />}
            disabled={boostFee == null}
            onClick={() => choose('boost')}
          >
            Boost{boostFee != null ? ` · ${numberWithCommas(boostFee)} Buzz` : ''}
          </Button>
          <Button variant="default" onClick={() => choose('continue')}>
            Continue without boosting
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}

/** Resolves to the user's choice, or null if they dismissed the dialog. */
export function confirmDownloadBoost(props: {
  preparation: DownloadPreparation;
  boostFee: number | null;
}) {
  return new Promise<DownloadBoostChoice | null>((resolve) => {
    let resolved = false;
    const settle = (choice: DownloadBoostChoice | null) => {
      if (resolved) return;
      resolved = true;
      resolve(choice);
    };
    dialogStore.trigger({
      id: 'download-boost-confirm',
      component: DownloadBoostConfirmModal,
      props: { ...props, onResolve: settle },
      // A dismissal that never reaches `onResolve` — Escape, the overlay, a route change — would
      // otherwise leave the submit waiting on a promise nothing settles.
      options: { onClose: () => settle(null) },
    });
  });
}
