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
  ThemeIcon,
} from '@mantine/core';
import {
  IconCircleCheck,
  IconInfoCircle,
  IconLock,
  IconPackage,
  IconScale,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { ComponentProps, ReactNode } from 'react';
import { useMemo, useRef, useState } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useServiceBuzzType } from '~/components/CreatorShop/Services/useServiceBuzzType';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import {
  serviceHoldButtonProps,
  serviceTermsLine,
} from '~/components/CreatorShop/Services/creator-service.util';
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
  BUYER_DISCLOSURE_VERSION,
  buyerDisclosureItems,
  type BuyerDisclosureItemId,
  buyerHoldButtonLabel,
} from '~/shared/constants/creator-service-terms.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { priceServiceRequest, serviceRequestFormSchema } from '~/shared/utils/service-request-form';
import {
  initialServiceFormAnswers,
  ServiceRequestFormFields,
} from '~/components/CreatorShop/Services/deals/ServiceRequestFormFields';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const REQUEST_MAX = 5000;

export function ServiceRequestModal({
  offering,
  sellerUsername,
  sellerId,
  seller,
  origin = 'listing',
}: {
  /** Where the popup opened. */
  origin?: 'listing' | 'page';
  seller?: RequestSeller;
  sellerId?: number;
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
    | 'requestForm'
    | 'requestFormVersion'
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
  const form = useMemo(
    () => serviceRequestFormSchema.safeParse(offering.requestForm).data ?? null,
    [offering.requestForm]
  );
  const [answers, setAnswers] = useState(() => (form ? initialServiceFormAnswers(form) : {}));
  const priced = form ? priceServiceRequest(form, offering, answers) : null;
  const terms = priced?.ok
    ? { ...offering, price: priced.price, deliveryDays: priced.deliveryDays }
    : offering;
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
  const disabled = !trimmed || (licensed && !licenseAgreed) || (!!priced && !priced.ok);
  const sendRequest = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    request.mutate({
      offeringId: offering.id,
      expectedPrice: terms.price,
      expectedRevisionsIncluded: offering.revisionsIncluded,
      expectedDeliveryDays: terms.deliveryDays,
      ...(form ? { formVersion: offering.requestFormVersion, formAnswers: answers } : {}),
      expectedLicense: {
        licensePreset: offering.licensePreset,
        licenseCustomText: offering.licenseCustomText,
        licenseAllowResale: offering.licenseAllowResale,
      },
      licenseAgreed: licensed && licenseAgreed,
      requestText: trimmed,
      disclosureVersion: BUYER_DISCLOSURE_VERSION,
      // The flag that sets the deal's reviewEnabledAt picks the disclosure shown; the server checks they match.
      disclosureReviewEnabled: !!features?.creatorServicesNext,
    });
  };

  return (
    <Modal {...dialog} size="lg" title={`Request: ${offering.title}`}>
      <Stack gap="md">
        <ServiceOfferingTerms
          offering={terms}
          sellerUsername={sellerUsername}
          seller={seller}
          sellerId={sellerId}
          showDescription={origin !== 'page'}
        />
        <Textarea
          label="What do you want?"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          autosize
          minRows={4}
          maxLength={REQUEST_MAX}
          withAsterisk
        />
        {form && priced && (
          <ServiceRequestFormFields
            form={form}
            answers={answers}
            onChange={setAnswers}
            priced={priced}
          />
        )}
        <ServiceBuyerDisclosure offering={terms} />
        <ServiceOfferingLicense offering={offering}>
          <Checkbox
            label={SERVICE_LICENSE_AGREE_LABEL}
            checked={licenseAgreed}
            onChange={(e) => setLicenseAgreed(e.currentTarget.checked)}
          />
        </ServiceOfferingLicense>
        <Group
          justify="flex-end"
          className={
            features?.creatorServicesNext
              ? '-mx-md px-md pt-md border-t border-gray-3 dark:border-dark-4'
              : undefined
          }
        >
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          {features?.creatorServicesNext ? (
            <BuzzTransactionButton
              buzzAmount={terms.price}
              colorType={buzzType}
              {...serviceHoldButtonProps(terms.price)}
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
              {buyerHoldButtonLabel(terms.price)}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

type RequestOffering = Parameters<typeof ServiceRequestModal>[0]['offering'];
type RequestSeller = ComponentProps<typeof UserAvatar>['user'];

// By item, not position, so each line keeps its own icon.
const DISCLOSURE_ICONS: Record<BuyerDisclosureItemId, typeof IconLock> = {
  hold: IconLock,
  delivery: IconPackage,
  accept: IconCircleCheck,
  cancel: IconScale,
  dispute: IconShieldCheck,
  party: IconInfoCircle,
};

/** Who it's from, its terms and its full description: what a buyer reads before requesting. */
export function ServiceOfferingTerms({
  offering,
  sellerUsername,
  sellerId,
  seller,
  showDescription = true,
}: {
  offering: RequestOffering;
  sellerUsername: string;
  /** With the seller's user (and cosmetics), the standard avatar replaces the plain name. */
  seller?: RequestSeller;
  sellerId?: number;
  /** False where the page behind the popup already shows it. */
  showDescription?: boolean;
}) {
  const features = useOptionalFeatureFlags();
  if (!features?.creatorServicesNext)
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
  return (
    <>
      <Stack gap={6}>
        <UserAvatar
          user={seller ?? { id: sellerId, username: sellerUsername }}
          withUsername
          linkToProfile
          size="md"
        />
        <Text size="sm" c="dimmed">
          {serviceTermsLine(offering)}
        </Text>
      </Stack>
      {showDescription && (
        <Stack gap={4}>
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            About this service
          </Text>
          <Paper withBorder radius="md" p="sm">
            <Text size="sm" className="whitespace-pre-line break-words">
              {offering.description}
            </Text>
          </Paper>
        </Stack>
      )}
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
  const features = useOptionalFeatureFlags();
  const reviewEnabled = !!features?.creatorServicesNext;
  const items = buyerDisclosureItems({ ...offering, reviewEnabled });
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
        {reviewEnabled ? (
          <Stack gap="sm">
            {items.map(({ id, lead, text }) => {
              const Icon = DISCLOSURE_ICONS[id];
              return (
                <Group key={id} gap="sm" wrap="nowrap" align="flex-start">
                  <ThemeIcon variant="light" color="gray" radius="xl" size={30}>
                    <Icon size={18} aria-hidden />
                  </ThemeIcon>
                  <Text size="sm">
                    <Text span fw={600} inherit>
                      {lead}
                    </Text>{' '}
                    {text}
                  </Text>
                </Group>
              );
            })}
          </Stack>
        ) : (
          <List size="sm" spacing={4}>
            {items.map(({ lead, text }) => (
              <List.Item key={lead}>
                <Text span fw={600} inherit>
                  {lead}
                </Text>{' '}
                {text}
              </List.Item>
            ))}
          </List>
        )}
      </Stack>
    </Paper>
  );
}
