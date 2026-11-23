import { Accordion, Badge, Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconChecks, IconClock, IconMoodHappy, IconShare3 } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import type { ComponentProps } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import {
  pluralize,
  sellerRecordLine,
} from '~/components/CreatorShop/Services/creator-service.util';
import {
  ServiceOfferingLicense,
  ServiceRequestModal,
} from '~/components/CreatorShop/Services/deals/ServiceRequestModal';
import { SERVICE_LICENSE_PRESET_LABELS } from '~/shared/constants/creator-service-license.constants';
import {
  BlurCaption,
  COVER_ASPECT_RATIO,
  NoCover,
} from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { ServiceOfferingMenu } from '~/components/CreatorShop/Services/ServiceOfferingMenu';
import { ServiceReviews } from '~/components/CreatorShop/Services/ServiceReviews';
import { servicePageHref } from '~/components/CreatorShop/section-meta';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { DetailsAccordion } from '~/components/DetailsAccordion/DetailsAccordion';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  SERVICE_PREVIEW_KIND_LABELS,
  serviceHappyShare,
} from '~/shared/constants/creator-service.constants';
import { Currency, ServiceOfferingStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.creatorShop || !features?.creatorServices || !features?.creatorServicesNext)
      return { notFound: true };
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };
    const offering = await ssg?.creatorService.getById
      .fetch({ id: result.data.id })
      .catch(() => null);
    if (!offering) return { notFound: true };
    return { props: { id: result.data.id } };
  },
});

function ServicePage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const [buzzType] = useAvailableBuzz();
  const { data: offering, isLoading } = trpc.creatorService.getById.useQuery({ id });

  if (isLoading) return <PageLoader />;
  if (!offering) return <NotFound />;

  const { seller, record, coverImage: cover } = offering;
  const sellerUsername = seller.username ?? '';
  const isOwner = currentUser?.id === seller.id;
  const isModerator = !!currentUser?.isModerator;
  const isActive = offering.status === ServiceOfferingStatus.Active;
  const happy = serviceHappyShare([offering]);
  const full = offering.slotsOpen === 0;
  const recordLine = sellerRecordLine(record);
  const href = servicePageHref(offering.id, offering.title);

  const details: ComponentProps<typeof DescriptionTable>['items'] = [
    {
      label: 'Price',
      value: (
        <Group gap={4} wrap="nowrap">
          <CurrencyIcon currency={Currency.BUZZ} size={14} />
          {offering.price.toLocaleString()} Buzz
        </Group>
      ),
    },
    { label: 'Delivery', value: `~${pluralize(offering.deliveryDays, 'day')}` },
    { label: 'Revisions', value: `${offering.revisionsIncluded} included` },
    { label: 'Preview', value: SERVICE_PREVIEW_KIND_LABELS[offering.previewKind] },
    {
      label: 'License',
      value: offering.licensePreset
        ? SERVICE_LICENSE_PRESET_LABELS[offering.licensePreset]
        : 'Not set',
    },
    {
      label: 'Slots',
      value: full ? 'Fully booked' : `${offering.slotsOpen} of ${offering.maxOpenDeals} open`,
      visible: offering.maxOpenDeals != null,
    },
    {
      label: 'Rating',
      value: <BrowsingLevelBadge browsingLevel={offering.maxNsfwLevel} size="sm" radius="sm" />,
    },
    { label: 'Listed', value: formatDate(offering.createdAt) },
    { label: 'Updated', value: formatDate(offering.updatedAt) },
  ];

  return (
    <>
      <Meta
        title={`${offering.title} | Services | Civitai`}
        description={offering.description.slice(0, 200)}
        canonical={href}
        images={cover ?? undefined}
        deIndex={!isActive}
      />
      <Container size="xl" className="pb-8">
        <Stack gap="md">
          <Stack gap="xs">
            <Group gap="xs" align="flex-start" justify="space-between" wrap="nowrap">
              <Group gap="xs" align="center" wrap="wrap" className="min-w-0">
                <Title order={1} lineClamp={2} className="break-words">
                  {offering.title}
                </Title>
                {!isActive && (
                  <Badge color="yellow" variant="light">
                    {offering.status}
                  </Badge>
                )}
              </Group>
              <Group gap={8} wrap="nowrap" className="shrink-0">
                <ShareButton url={href} title={offering.title}>
                  <LegacyActionIcon variant="light" w={32} h={32} aria-label="Share">
                    <IconShare3 size={16} />
                  </LegacyActionIcon>
                </ShareButton>
                <ServiceOfferingMenu
                  offering={offering}
                  isOwner={isOwner}
                  isModerator={isModerator}
                  placement="title"
                />
              </Group>
            </Group>
            <Group gap="xs">
              <IconBadge radius="sm" size="lg" icon={<IconChecks size={18} />}>
                <Text size="sm">{record.offeringCompleted.toLocaleString()} completed</Text>
              </IconBadge>
              <IconBadge radius="sm" size="lg" icon={<IconClock size={18} />}>
                <Text size="sm">~{pluralize(offering.deliveryDays, 'day')}</Text>
              </IconBadge>
              {happy && (
                <IconBadge radius="sm" size="lg" color="green" icon={<IconMoodHappy size={18} />}>
                  <Text size="sm">{happy.percent}% happy</Text>
                </IconBadge>
              )}
            </Group>
          </Stack>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Stack gap="md">
              {cover ? (
                <AspectRatioImageCard
                  alt={offering.title}
                  aspectRatio={COVER_ASPECT_RATIO}
                  image={{ ...cover, metadata: cover.metadata as MixedObject | null }}
                  explain={false}
                  overlay={({ safe }) => (safe ? null : <BlurCaption level={cover.nsfwLevel} />)}
                />
              ) : (
                <div
                  className="overflow-hidden rounded-md"
                  style={{ aspectRatio: COVER_ASPECT_RATIO }}
                >
                  <NoCover />
                </div>
              )}
              <Stack gap="xs" className="rounded-md border border-gray-3 p-4 dark:border-dark-4">
                <Title order={2} size="h4">
                  About this service
                </Title>
                <Text className="whitespace-pre-wrap break-words">{offering.description}</Text>
              </Stack>
              <ServiceReviews offering={offering} isOwner={isOwner} />
            </Stack>

            <Stack gap="md">
              {isOwner ? (
                <Button
                  component={NextLink}
                  href={`/user/${sellerUsername}/shop/manage?tab=services&edit=${offering.id}`}
                  variant="default"
                  size="lg"
                  fullWidth
                >
                  Manage
                </Button>
              ) : (
                <LoginRedirect reason="perform-action">
                  {/* No funds check: the hold is placed in the popup. */}
                  <Button
                    color={buzzType}
                    size="lg"
                    fullWidth
                    disabled={!isActive || full}
                    onClick={() =>
                      dialogStore.trigger({
                        component: ServiceRequestModal,
                        props: { offering, sellerUsername },
                      })
                    }
                  >
                    {full ? 'Fully booked' : `Request · ${offering.price.toLocaleString()} Buzz`}
                  </Button>
                </LoginRedirect>
              )}

              <DetailsAccordion defaultValue="details">
                <Accordion.Item value="details">
                  <Accordion.Control>Details</Accordion.Control>
                  <Accordion.Panel p={0}>
                    <DescriptionTable items={details} labelWidth="40%" withBorder={false} />
                  </Accordion.Panel>
                </Accordion.Item>
              </DetailsAccordion>

              <ServiceOfferingLicense offering={offering} />

              <SmartCreatorCard
                user={seller}
                footer={
                  recordLine ? (
                    <Text size="sm" c="dimmed">
                      {recordLine}
                    </Text>
                  ) : undefined
                }
              />
            </Stack>
          </div>
        </Stack>
      </Container>
    </>
  );
}

export default Page(ServicePage);
