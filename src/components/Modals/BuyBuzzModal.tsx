import { Badge, CloseButton, Group, Stack, Text, Divider } from '@mantine/core';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserBuzz } from '../User/UserBuzz';
import { BuzzPurchase } from '~/components/Buzz/BuzzPurchase';
import { useTrackEvent } from '../TrackView/track.utils';

const { openModal, Modal } = createContextModal<{
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
}>({
  name: 'buyBuzz',
  withCloseButton: false,
  centered: true,
  size: 'lg',
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
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Buy Buzz
          </Text>
          <Group spacing="sm" noWrap>
            <Badge
              radius="xl"
              variant="filled"
              h="auto"
              py={4}
              px={12}
              sx={(theme) => ({
                backgroundColor:
                  theme.colorScheme === 'dark' ? theme.fn.rgba('#000', 0.31) : theme.colors.gray[0],
              })}
            >
              <Group spacing={4} noWrap>
                <Text size="xs" color="dimmed" transform="capitalize" weight={600}>
                  Available Buzz
                </Text>
                <UserBuzz iconSize={16} textSize="sm" withTooltip />
              </Group>
            </Badge>
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        <BuzzPurchase
          message={message}
          onPurchaseSuccess={() => {
            onPurchaseSuccess?.();
            context.close();
          }}
          minBuzzAmount={minBuzzAmount}
          purchaseSuccessMessage={purchaseSuccessMessage}
          onCancel={handleClose}
        />
      </Stack>
    );
  },
});

export const openBuyBuzzModal = openModal;
export default Modal;
