import { Badge, CloseButton, Group, Stack, Text, Divider } from '@mantine/core';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserBuzz } from '../User/UserBuzz';
import { BuzzPurchase } from '~/components/Buzz/BuzzPurchase';
import { useTrackEvent } from '../TrackView/track.utils';
import { AvailableBuzzBadge } from '~/components/Buzz/AvailableBuzzBadge';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';

const { openModal, Modal } = createContextModal<{
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
}>({
  name: 'buyBuzz',
  withCloseButton: false,
  centered: true,
  size: 'xl',
  radius: 'lg',
  zIndex: 400,
  Element: ({
    context,
    props: { message, onPurchaseSuccess, minBuzzAmount, purchaseSuccessMessage },
  }) => {
    const { trackAction } = useTrackEvent();
    const handleClose = () => {
      trackAction({ type: 'PurchaseFunds_Cancel', details: { step: 1 } }).catch(() => undefined);
      context.close();
    };

    return (
      <Stack spacing="lg">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Buy Buzz
          </Text>
          <Group spacing="sm" noWrap>
            <AvailableBuzzBadge />
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <DismissibleAlert
          id="rewards-program-notice"
          content={
            <Text align="center">
              <Text
                component="a"
                href="/user/buzz-dashboard#rewards"
                target="_blank"
                variant="link"
                td="underline"
              >
                Learn how to earn free Buzz daily
              </Text>
            </Text>
          }
          radius="md"
        />
        <Divider mx="-lg" />
        <Group>
          <BuzzPurchase
            message={message}
            onPurchaseSuccess={() => {
              context.close();
              onPurchaseSuccess?.();
            }}
            minBuzzAmount={minBuzzAmount}
            purchaseSuccessMessage={purchaseSuccessMessage}
            onCancel={handleClose}
          />
        </Group>
      </Stack>
    );
  },
});

export const openBuyBuzzModal = openModal;
export default Modal;
