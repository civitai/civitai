import {
  Anchor,
  Badge,
  Button,
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconMessage } from '@tabler/icons-react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Countdown } from '~/components/Countdown/Countdown';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { DealAccountabilitySheet } from '~/components/CreatorShop/Services/deals/DealAccountabilitySheet';
import { DealActionsPanel } from '~/components/CreatorShop/Services/deals/DealActionsPanel';
import { DealEscrowPanel } from '~/components/CreatorShop/Services/deals/DealEscrowPanel';
import { DealFilesPanel } from '~/components/CreatorShop/Services/deals/DealFilesPanel';
import { ServiceRatingBadge } from '~/components/CreatorShop/Services/ServiceRatingBadge';
import { ReportServiceButton } from '~/components/CreatorShop/Services/ReportServiceButton';
import { Gated } from '~/components/Gated/Gated';
import {
  dealPageState,
  dealStatusLabel,
  disputeNotice,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { useServiceDeal } from '~/components/CreatorShop/Services/deals/deal.util';
import { NextLink } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate } from '~/utils/date-helpers';

const DATE = 'MMM D, YYYY h:mm A';

function deadlineLines(deal: ServiceDealView) {
  const { deadlines, viewerRole } = deal;
  const lines: string[] = [];
  if (deadlines.acceptBy)
    lines.push(
      viewerRole === 'seller'
        ? `Accept or decline by ${formatDate(
            deadlines.acceptBy,
            DATE
          )}, or it expires and the buyer is refunded.`
        : `If the seller doesn't answer by ${formatDate(
            deadlines.acceptBy,
            DATE
          )}, the request expires and you're refunded.`
    );
  if (deadlines.due) lines.push(`Due ${formatDate(deadlines.due, DATE)}.`);
  if (deadlines.lateCancelFrom && viewerRole === 'buyer')
    lines.push(
      `If it's still not delivered, you can cancel from ${formatDate(
        deadlines.lateCancelFrom,
        DATE
      )}.`
    );
  if (deadlines.autoCompleteAt)
    lines.push(
      viewerRole === 'buyer'
        ? `Accept it or ask for a revision by ${formatDate(
            deadlines.autoCompleteAt,
            DATE
          )}. If you don't respond, the delivery is accepted for you.`
        : `If the buyer doesn't respond by ${formatDate(
            deadlines.autoCompleteAt,
            DATE
          )}, the delivery is accepted automatically.`
    );
  if (deadlines.autoCancelAt)
    lines.push(
      `Unanswered, the cancellation goes through on ${formatDate(deadlines.autoCancelAt, DATE)}.`
    );
  return lines;
}

/** The 48h after completion when the buyer can still report the final files; payout follows. */
function DisputeWindow({ deal, until }: { deal: ServiceDealView; until: Date }) {
  const at = formatDate(until, DATE);
  const body = {
    buyer: `If the final files are missing, broken or not what the preview showed, report it before ${at}. After that, the Buzz is paid to the seller.`,
    seller: `The Buzz is paid to you after ${at}, unless the buyer reports a problem with the files before then.`,
    moderator: `The buyer can report a problem until ${at}. After that, the Buzz is paid to the seller.`,
  }[deal.viewerRole];
  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap={4}>
        <Text fw={600}>
          {until > new Date() ? (
            <>
              Dispute window closes in <Countdown endTime={until} />
            </>
          ) : (
            'The dispute window has closed'
          )}
        </Text>
        <Text size="sm" c="dimmed">
          {body}
        </Text>
      </Stack>
    </Paper>
  );
}

export function ServiceDealPage({ dealId }: { dealId: number }) {
  const { deal, isLoading, error, refetch } = useServiceDeal(dealId);
  const features = useFeatureFlags();
  const state = dealPageState({ isLoading, hasDeal: !!deal, error });

  if (state.kind === 'loading')
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  if (state.kind === 'error')
    return (
      <Center py="xl">
        <Stack align="center" gap="sm">
          <Text>This deal could not be loaded.</Text>
          <Button variant="default" onClick={() => refetch()}>
            Try again
          </Button>
        </Stack>
      </Center>
    );
  if (state.kind === 'notFound' || !deal) return <NotFound />;

  const counterparty = deal.viewerRole === 'seller' ? deal.buyer : deal.seller;
  const lines = deadlineLines(deal);
  const notice = disputeNotice(deal);

  // A mature deal opened on green redirects to red. Exits stay open on the server either way.
  return (
    <Gated contentNsfwLevel={deal.maxNsfwLevel} meta={{ title: 'Service deal', deIndex: true }}>
      <Stack gap="lg" py="md">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            Deal #{deal.id} ·{' '}
            <Anchor component={NextLink} href={`/user/${deal.seller.username}/shop`} inherit>
              {deal.seller.username}&apos;s shop
            </Anchor>
            {/* With Services off, the list and the manage tab are gone; the deal page stays. */}
            {features.creatorServices && deal.viewerRole !== 'moderator' && (
              <>
                {' · '}
                <Anchor
                  component={NextLink}
                  href={
                    deal.viewerRole === 'buyer'
                      ? '/services/deals'
                      : `/user/${deal.seller.username}/shop/manage?tab=services`
                  }
                  inherit
                >
                  {deal.viewerRole === 'buyer'
                    ? 'See all your requests'
                    : 'See all requests to you'}
                </Anchor>
              </>
            )}
          </Text>
          <Group gap="sm" wrap="wrap">
            <Title order={1} size="h2">
              {deal.offering.title}
            </Title>
            <Badge variant="light" color="violet">
              {dealStatusLabel[deal.status]}
            </Badge>
            <ServiceRatingBadge rating={deal.maxNsfwLevel} />
            {deal.viewerRole === 'buyer' && <ReportServiceButton offeringId={deal.offering.id} />}
          </Group>
          <Text size="sm" c="dimmed">
            {deal.viewerRole === 'seller' ? 'Requested by' : 'With'}{' '}
            <Anchor component={NextLink} href={`/user/${counterparty.username}`} inherit>
              {counterparty.username}
            </Anchor>{' '}
            · requested {formatDate(deal.requestedAt, DATE)} · ~{deal.deliveryDays} days ·{' '}
            {deal.revisionsUsed}/{deal.revisionsIncluded} revisions used
          </Text>
        </Stack>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, md: 7 }}>
            <Stack gap="lg">
              <DealEscrowPanel deal={deal} />
              {deal.deadlines.disputeUntil && (
                <DisputeWindow deal={deal} until={deal.deadlines.disputeUntil} />
              )}
              {lines.length > 0 && (
                <Paper withBorder radius="md" p="md">
                  <Stack gap={4}>
                    {lines.map((line) => (
                      <Text key={line} size="sm">
                        {line}
                      </Text>
                    ))}
                  </Stack>
                </Paper>
              )}
              <DealActionsPanel deal={deal} />
              <DealFilesPanel deal={deal} />
              <Paper withBorder radius="md" p="md">
                <Stack gap={6}>
                  <Text fw={600}>The request</Text>
                  <Text size="sm" className="whitespace-pre-line break-words">
                    {deal.requestText}
                  </Text>
                </Stack>
              </Paper>
              {notice && (
                <Paper withBorder radius="md" p="md">
                  <Text size="sm">{notice}</Text>
                </Paper>
              )}
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 5 }}>
            <Stack gap="lg">
              {deal.chatId && (
                <Button
                  onClick={() =>
                    useChatStore.setState({ open: true, existingChatId: deal.chatId ?? undefined })
                  }
                  variant="light"
                  leftSection={<IconMessage size={16} />}
                >
                  Open the deal chat
                </Button>
              )}
              <DealAccountabilitySheet deal={deal} />
            </Stack>
          </Grid.Col>
        </Grid>
      </Stack>
    </Gated>
  );
}
