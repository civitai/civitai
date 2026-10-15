import { Anchor, Button, Group, Modal, Paper, Stack, Text, Textarea } from '@mantine/core';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import { isConflict } from '~/components/CreatorShop/Services/deals/deal.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { useDomainColor } from '~/hooks/useDomainColor';
import { Currency } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const REQUEST_MAX = 5000;

export function ServiceRequestModal({
  offering,
  sellerUsername,
}: {
  offering: Pick<ServiceOffering, 'id' | 'title' | 'price' | 'deliveryDays' | 'revisionsIncluded'>;
  sellerUsername: string;
}) {
  const dialog = useDialogContext();
  const router = useRouter();
  const domain = useDomainColor();
  const utils = trpc.useUtils();
  const [text, setText] = useState('');

  const request = trpc.creatorServiceDeal.request.useMutation({
    onSuccess: async ({ id }) => {
      await utils.creatorService.getForShop.invalidate();
      showSuccessNotification({
        title: 'Request sent',
        message: (
          <Text size="sm">
            Your Buzz is held until the deal completes.{' '}
            <Anchor component={NextLink} href="/services/deals" inherit>
              See your service requests
            </Anchor>
          </Text>
        ),
      });
      dialog.onClose();
      await router.push(`/services/deals/${id}`);
    },
    onError: async (error) => {
      if (isConflict(error)) {
        // The price moved after the page loaded: nothing was charged. Show the new price.
        await utils.creatorService.getForShop.invalidate();
        dialog.onClose();
        showErrorNotification({
          title: 'The price of this service has changed',
          error: { message: 'Nothing was charged. Check the new price and request again.' },
        });
        return;
      }
      showErrorNotification({ title: 'Could not send the request', error });
    },
  });

  const trimmed = text.trim();

  return (
    <Modal {...dialog} size="lg" title={`Request: ${offering.title}`}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          From {sellerUsername} · {serviceTermsLine(offering)}
        </Text>
        <Textarea
          label="What do you want?"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          autosize
          minRows={4}
          maxLength={REQUEST_MAX}
          withAsterisk
        />
        <Paper withBorder radius="md" p="md">
          <Stack gap={4}>
            <Group justify="space-between">
              <Text fw={600}>Escrow</Text>
              <CurrencyBadge
                currency={Currency.BUZZ}
                type={domain === 'green' ? 'green' : 'yellow'}
                unitAmount={offering.price}
                variant="transparent"
              />
            </Group>
            <Text size="sm" c="dimmed">
              Held now, not paid. {sellerUsername} is paid only when the deal completes. If they
              decline, or don&apos;t answer in time, it comes back to you.
            </Text>
          </Stack>
        </Paper>
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            color="yellow"
            disabled={!trimmed}
            loading={request.isPending}
            onClick={() =>
              request.mutate({
                offeringId: offering.id,
                expectedPrice: offering.price,
                requestText: trimmed,
              })
            }
          >
            Send request · hold {offering.price.toLocaleString()} Buzz
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
