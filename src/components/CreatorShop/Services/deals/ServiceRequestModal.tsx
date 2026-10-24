import { Anchor, Button, Group, List, Modal, Paper, Stack, Text, Textarea } from '@mantine/core';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import { isConflict } from '~/components/CreatorShop/Services/deals/deal.util';
import { requestSentMessage } from '~/components/CreatorShop/Services/deals/deal-ui';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { useDomainColor } from '~/hooks/useDomainColor';
import {
  BUYER_DISCLOSURE_INTRO,
  SERVICES_TERMS_VERSION,
  buyerDisclosureItems,
  buyerHoldButtonLabel,
} from '~/shared/constants/creator-service-terms.constants';
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
  // Each request is a separate hold, so a second click must never fire before the first settles.
  const inFlight = useRef(false);

  const request = trpc.creatorServiceDeal.request.useMutation({
    onSettled: () => {
      inFlight.current = false;
    },
    onSuccess: async ({ id, held }) => {
      await utils.creatorService.getForShop.invalidate();
      showSuccessNotification({
        title: 'Request sent',
        message: (
          <Text size="sm">
            {requestSentMessage(held)}{' '}
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
        // The price moved, or this buyer already has a request open on it. Either way nothing
        // was charged; the server's message says which.
        await utils.creatorService.getForShop.invalidate();
        dialog.onClose();
        showErrorNotification({
          title: 'Request not sent',
          error: { message: `${error.message} Nothing was charged.` },
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
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>{BUYER_DISCLOSURE_INTRO}</Text>
              <CurrencyBadge
                currency={Currency.BUZZ}
                type={domain === 'green' ? 'green' : 'yellow'}
                unitAmount={offering.price}
                variant="transparent"
              />
            </Group>
            <List size="sm" spacing={4}>
              {buyerDisclosureItems(offering).map((item) => (
                <List.Item key={item}>{item}</List.Item>
              ))}
            </List>
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
            onClick={() => {
              if (inFlight.current) return;
              inFlight.current = true;
              request.mutate({
                offeringId: offering.id,
                expectedPrice: offering.price,
                expectedRevisionsIncluded: offering.revisionsIncluded,
                expectedDeliveryDays: offering.deliveryDays,
                requestText: trimmed,
                disclosureVersion: SERVICES_TERMS_VERSION,
              });
            }}
          >
            {buyerHoldButtonLabel(offering.price)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
