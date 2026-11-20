import { Accordion, Badge, Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import {
  IconChecks,
  IconClock,
  IconFlag,
  IconInfoCircle,
  IconMoodHappy,
  IconShare3,
} from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import type { ComponentProps } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { pluralize } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceRequestModal } from '~/components/CreatorShop/Services/deals/ServiceRequestModal';
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
import { openReportModal } from '~/components/Dialog/triggers/report';
import { IconBadge } from '~/components/IconBadge/IconBadge';
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
import { SERVICE_DEAL_DISPUTE_WINDOW_MS } from '~/shared/constants/creator-services.constants';
import { Currency, ServiceOfferingStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { ReportEntity } from '~/shared/utils/report-helpers';
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

const disputeWindowHours = SERVICE_DEAL_DISPUTE_WINDOW_MS / 3_600_000;

function ServicePage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
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
  const onTimePct = record.completed ? Math.round((record.onTime / record.completed) * 100) : null;
  const href = servicePageHref(offering.id, offering.title);

  const details: ComponentProps<typeof DescriptionTable>['items'] = [
    {
      label: 'Price',
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          <CurrencyIcon currency={Currency.BUZZ} size={14} />
          {offering.price.toLocaleString()} Buzz
        </Group>
      ),
    },
    { label: 'Delivery', value: `~${pluralize(offering.deliveryDays, 'day')}` },
    { label: 'Revisions', value: `${offering.revisionsIncluded} included` },
    { label: 'Preview', value: SERVICE_PREVIEW_KIND_LABELS[offering.previewKind] },
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
            <Group gap="xs" align="center" wrap="wrap">
              <Title order={1} lineClamp={2} className="break-words">
                {offering.title}
              </Title>
              {!isActive && (
                <Badge color="yellow" variant="light">
                  {offering.status}
                </Badge>
              )}
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
              <ServiceReviews offering={offering} />
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
                  <Button
                    color="yellow"
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

              <Group gap="xs" grow>
                <ShareButton url={href} title={offering.title}>
                  <Button
                    variant="default"
                    aria-label="Share"
                    leftSection={<IconShare3 size={18} />}
                  >
                    Share
                  </Button>
                </ShareButton>
                {!isOwner && (
                  <LoginRedirect reason="report-content">
                    <Button
                      variant="default"
                      aria-label="Report this service"
                      leftSection={<IconFlag size={18} />}
                      onClick={() =>
                        openReportModal({
                          entityType: ReportEntity.ServiceOffering,
                          entityId: offering.id,
                        })
                      }
                    >
                      Report
                    </Button>
                  </LoginRedirect>
                )}
                {(isOwner || isModerator) && (
                  <Group justify="center" className="grow-0">
                    <ServiceOfferingMenu
                      offering={offering}
                      isOwner={isOwner}
                      isModerator={isModerator}
                    />
                  </Group>
                )}
              </Group>

              <Accordion variant="separated" defaultValue="details">
                <Accordion.Item value="details">
                  <Accordion.Control>Details</Accordion.Control>
                  <Accordion.Panel>
                    <DescriptionTable items={details} labelWidth="40%" withBorder={false} />
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>

              <SmartCreatorCard
                user={seller}
                subText={
                  onTimePct != null
                    ? `${pluralize(record.completed, 'deal')} · ${onTimePct}% on time`
                    : undefined
                }
              />

              <AlertWithIcon icon={<IconInfoCircle />} color="blue" iconColor="blue" radius="md">
                Your Buzz is held in escrow. The seller is paid {disputeWindowHours} hours after you
                accept the delivery.
              </AlertWithIcon>
            </Stack>
          </div>
        </Stack>
      </Container>
    </>
  );
}

export default Page(ServicePage);
