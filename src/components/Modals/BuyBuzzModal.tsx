import { CloseButton, Group, Stack, Text, Divider, Modal, Anchor } from '@mantine/core';

import { BuzzPurchase } from '~/components/Buzz/BuzzPurchase/BuzzPurchase';
import { useTrackEvent } from '../TrackView/track.utils';
import { AvailableBuzzBadge } from '~/components/Buzz/AvailableBuzzBadge';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { isMobileDevice } from '~/hooks/useIsMobile';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BuzzPurchaseImproved } from '~/components/Buzz/BuzzPurchaseImproved';

export type BuyBuzzModalProps = {
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
  initialBuzzType?: BuzzSpendType;
};

export default function BuyBuzzModal({
  message,
  purchaseSuccessMessage,
  onPurchaseSuccess,
  minBuzzAmount,
}: BuyBuzzModalProps) {
  const dialog = useDialogContext();
  const { trackAction } = useTrackEvent();
  const handleClose = () => {
    trackAction({ type: 'PurchaseFunds_Cancel', details: { step: 1 } }).catch(() => undefined);
    dialog.onClose();
  };
  const isMobile = isMobileDevice();

  return (
    <Modal
      {...dialog}
      id="buyBuzz"
      withCloseButton={false}
      size="xxl"
      radius="lg"
      fullScreen={isMobile}
    >
      <Stack gap="lg">
        <Group justify="space-between" wrap="nowrap">
          <Text size="lg" fw={700}>
            Buy Buzz
          </Text>
          <Group gap="sm" wrap="nowrap">
            <AvailableBuzzBadge />
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <DismissibleAlert
          id="rewards-program-notice"
          content={
            <Anchor
              size="sm"
              href="/user/buzz-dashboard#rewards"
              target="_blank"
              td="underline"
              inherit
            >
              Learn how to earn free Buzz daily
            </Anchor>
          }
          radius="md"
        />
        <Divider mx="-lg" />
        <Group>
          <BuzzPurchaseImproved
            message={message}
            onPurchaseSuccess={() => {
              dialog.onClose();
              onPurchaseSuccess?.();
            }}
            minBuzzAmount={minBuzzAmount}
            purchaseSuccessMessage={purchaseSuccessMessage}
            onCancel={handleClose}
          />
        </Group>
      </Stack>
    </Modal>
  );
}
