import { Badge, Button, CloseButton, Divider, Group, Stack, Text } from '@mantine/core';
import React, { useEffect } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { UserBuzz } from '../User/UserBuzz';
import { useModelVersionPurchase } from '~/components/Model/ModelVersions/useModelVersionPurchase';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';

const { openModal, Modal } = createContextModal<{
  modelVersionId: number;
  onSuccess?: () => void;
}>({
  name: 'purchaseModelVersion',
  centered: true,
  radius: 'lg',
  withCloseButton: false,
  Element: ({ context, props: { modelVersionId, onSuccess } }) => {
    const currentUser = useCurrentUser();
    const { price, isLoading } = useModelVersionPurchase({ modelVersionId });
    const purchaseModelVersionMutation = trpc.modelVersionPurchase.purchase.useMutation({
      async onSuccess() {
        onSuccess?.();
        context.close();
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to purchase this model',
          error: new Error(error.message),
        });
      },
    });

    const onClose = () => context.close();
    const onPurchase = () => {
      if (!currentUser || !price?.unitAmount) return;

      if (currentUser.balance < price.unitAmount) {
        // TODO: open purchase modal
        console.log('Welp, buy more buzz');
        return;
      }

      purchaseModelVersionMutation.mutate({ modelVersionId });
    };

    useEffect(() => {
      if (!price && !isLoading) {
        onClose();
      }
    }, [price]);

    if (!price || !price.unitAmount) {
      return (
        <Stack spacing="md">
          <Text>Sorry, it looks like you&rsquo;re in the wrong place</Text>
        </Stack>
      );
    }

    return (
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Purchase model
          </Text>
          <Group spacing="sm" noWrap>
            <UserBuzz user={currentUser} withTooltip />
            <Badge radius="xl" color="gray.9" variant="filled" px={12}>
              <Text size="xs" transform="capitalize" weight={600}>
                Available Buzz
              </Text>
            </Badge>
            <CloseButton iconSize={22} onClick={onClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        <Stack>
          <Text>
            The model version you want to purchase has a one time fee of{' '}
            <CurrencyBadge
              currency={price.currency ?? Currency.BUZZ}
              unitAmount={price.unitAmount}
            />
          </Text>
          <Text color="red">Purchasing a model version is not refundable.</Text>
          <Group position="right" mt="xl">
            <Button variant="light" color="gray" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={onPurchase}
              loading={purchaseModelVersionMutation.isLoading}
              color="yellow.7"
            >
              Purchase
            </Button>
          </Group>
        </Stack>
      </Stack>
    );
  },
});

export const openPurchaseModelVersionModal = openModal;
export default Modal;
