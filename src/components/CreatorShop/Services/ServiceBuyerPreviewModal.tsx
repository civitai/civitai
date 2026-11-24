import { Modal, Stack, Text } from '@mantine/core';
import type { ComponentProps } from 'react';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import {
  ServiceBuyerDisclosure,
  ServiceOfferingLicense,
  ServiceOfferingTerms,
} from '~/components/CreatorShop/Services/deals/ServiceRequestModal';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

/** A seller's own offering as a buyer sees it: the card, then what the request form shows. */
export default function ServiceBuyerPreviewModal(
  card: Omit<ComponentProps<typeof ServiceOfferingCard>, 'preview' | 'href' | 'extra'>
) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} size="lg" title="Preview as a buyer">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          This is your service as buyers see it. Nothing here can be requested.
        </Text>
        <div className="mx-auto w-full max-w-[320px]">
          <ServiceOfferingCard {...card} preview />
        </div>
        <ServiceOfferingTerms offering={card.offering} sellerUsername={card.sellerUsername} />
        <ServiceBuyerDisclosure offering={card.offering} />
        <ServiceOfferingLicense offering={card.offering} />
      </Stack>
    </Modal>
  );
}
