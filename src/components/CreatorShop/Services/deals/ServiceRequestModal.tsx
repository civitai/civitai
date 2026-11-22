import {
  Anchor,
  Button,
  Checkbox,
  Group,
  List,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useServiceBuzzType } from '~/components/CreatorShop/Services/useServiceBuzzType';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import {
  ServiceLicenseTerms,
  hasServiceLicense,
} from '~/components/CreatorShop/Services/ServiceLicenseTerms';
import { isConflict } from '~/components/CreatorShop/Services/deals/deal.util';
import { requestSentMessage } from '~/components/CreatorShop/Services/deals/deal-ui';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  SERVICE_LICENSE_AGREE_LABEL,
  SERVICE_LICENSE_NONE_LINE,
} from '~/shared/constants/creator-service-license.constants';
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
  offering: Pick<
    ServiceOffering,
    | 'id'
    | 'title'
    | 'description'
    | 'price'
    | 'deliveryDays'
    | 'revisionsIncluded'
    | 'licensePreset'
    | 'licenseCustomText'
    | 'licenseAllowResale'
  >;
  sellerUsername: string;
}) {
  const dialog = useDialogContext();
  const features = useOptionalFeatureFlags();
  const buzzType = useServiceBuzzType();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [text, setText] = useState('');
  const [licenseAgreed, setLicenseAgreed] = useState(false);
  const licensed = hasServiceLicense(offering);
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
  const disabled = !trimmed || (licensed && !licenseAgreed);
  const sendRequest = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    request.mutate({
      offeringId: offering.id,
      expectedPrice: offering.price,
      expectedRevisionsIncluded: offering.revisionsIncluded,
      expectedDeliveryDays: offering.deliveryDays,
      expectedLicense: {
        licensePreset: offering.licensePreset,
        licenseCustomText: offering.licenseCustomText,
        licenseAllowResale: offering.licenseAllowResale,
      },
      licenseAgreed: licensed && licenseAgreed,
      requestText: trimmed,
      disclosureVersion: SERVICES_TERMS_VERSION,
    });
  };

  return (
    <Modal {...dialog} size="lg" title={`Request: ${offering.title}`}>
      <Stack gap="md">
        <ServiceOfferingTerms offering={offering} sellerUsername={sellerUsername} />
        <Textarea
          label="What do you want?"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          autosize
          minRows={4}
          maxLength={REQUEST_MAX}
          withAsterisk
        />
        <ServiceBuyerDisclosure offering={offering} />
        <ServiceOfferingLicense offering={offering}>
          <Checkbox
            label={SERVICE_LICENSE_AGREE_LABEL}
            checked={licenseAgreed}
            onChange={(e) => setLicenseAgreed(e.currentTarget.checked)}
          />
        </ServiceOfferingLicense>
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          {features?.creatorServicesNext ? (
            <BuzzTransactionButton
              buzzAmount={offering.price}
              colorType={buzzType}
              // The badge carries the amount, so the label is the short form; the full legal text
              // stays as the accessible name.
              label="Hold and send request"
              aria-label={buyerHoldButtonLabel(offering.price)}
              // A buyer who is short buys Buzz, then clicks again: the hold is never placed on the
              // back of a purchase.
              performTransactionOnPurchase={false}
              disabled={disabled}
              loading={request.isPending}
              onPerformTransaction={sendRequest}
            />
          ) : (
            <Button
              color="yellow"
              disabled={disabled}
              loading={request.isPending}
              onClick={sendRequest}
            >
              {buyerHoldButtonLabel(offering.price)}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

type RequestOffering = Parameters<typeof ServiceRequestModal>[0]['offering'];

/** Who it's from, its terms and its full description: what a buyer reads before requesting. */
export function ServiceOfferingTerms({
  offering,
  sellerUsername,
}: {
  offering: RequestOffering;
  sellerUsername: string;
}) {
  return (
    <>
      <Text size="sm" c="dimmed">
        From {sellerUsername} · {serviceTermsLine(offering)}
      </Text>
      <Text size="sm" className="whitespace-pre-line">
        {offering.description}
      </Text>
    </>
  );
}

/**
 * The seller's license, shown to every buyer whatever their flags: terms a seller set apply to
 * each deal. With none set, only viewers in the `creatorServicesNext` rollout are told so.
 */
export function ServiceOfferingLicense({
  offering,
  children,
}: {
  offering: RequestOffering;
  /** Under the terms, when there are any. */
  children?: ReactNode;
}) {
  const features = useOptionalFeatureFlags();
  if (hasServiceLicense(offering))
    return <ServiceLicenseTerms license={offering}>{children}</ServiceLicenseTerms>;
  if (!features?.creatorServicesNext) return null;
  return (
    <Text size="sm" c="dimmed">
      {SERVICE_LICENSE_NONE_LINE}
    </Text>
  );
}

/** The hold disclosure a buyer agrees to with the price. */
export function ServiceBuyerDisclosure({ offering }: { offering: RequestOffering }) {
  const domain = useDomainColor();
  return (
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
  );
}
