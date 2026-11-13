import { Badge, Divider, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  groupEventsByRound,
  reasonLabel,
  roundLabel,
  sheetEventText,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { formatDate } from '~/utils/date-helpers';
import type { ServiceDealEventType } from '~/shared/utils/prisma/enums';

const eventLabel: Record<ServiceDealEventType, string> = {
  Requested: 'Requested the service',
  Accepted: 'Accepted the request',
  Declined: 'Declined the request',
  Expired: 'Request expired unanswered',
  Delivered: 'Delivered',
  RevisionRequested: 'Asked for a revision',
  Completed: 'Deal completed',
  CancellationRequested: 'Asked to cancel',
  CancellationAccepted: 'Agreed to cancel',
  CancellationDeclined: 'Refused to cancel',
  Cancelled: 'Deal cancelled',
  Disputed: 'Opened a dispute',
  DisputeResolved: 'Dispute resolved',
  DeadlineExtended: 'Deadline extended',
  Held: 'Buzz held in escrow',
  Released: 'Buzz released to the seller',
  Refunded: 'Buzz refunded to the buyer',
};

type DealEvent = ServiceDealView['events'][number];

function actorName(deal: ServiceDealView, event: DealEvent) {
  switch (event.actorRole) {
    case 'buyer':
      return deal.buyer.username ?? 'Buyer';
    case 'seller':
      return deal.seller.username ?? 'Seller';
    case 'moderator':
      return 'Moderator';
    default:
      return 'Civitai';
  }
}

/** Append-only record of who did what and when; comments are plain text by contract. */
export function DealAccountabilitySheet({ deal }: { deal: ServiceDealView }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Text fw={600}>Accountability sheet</Text>
        {deal.events.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing recorded yet.
          </Text>
        ) : (
          <Stack gap={0}>
            {groupEventsByRound(deal.events).map((group, groupIndex) => (
              <Stack key={`${group.round}-${groupIndex}`} gap={0}>
                <Divider
                  label={roundLabel(group.round)}
                  labelPosition="left"
                  className={groupIndex > 0 ? 'mt-2' : undefined}
                />
                {group.events.map((event) => {
                  const text = sheetEventText(event, deal.viewerRole, eventLabel[event.type]);
                  return (
                    <Group
                      key={event.id}
                      wrap="nowrap"
                      align="flex-start"
                      gap="sm"
                      className="border-t border-gray-3 py-3 first:border-t-0 dark:border-dark-4"
                    >
                      <ThemeIcon size={28} radius="xl" variant="light" color="gray">
                        <Text size="xs" fw={700}>
                          {deal.events.indexOf(event) + 1}
                        </Text>
                      </ThemeIcon>
                      <Stack gap={2} className="min-w-0 flex-1">
                        <Group gap="xs" wrap="wrap">
                          <Text size="sm" fw={600}>
                            {actorName(deal, event)}
                          </Text>
                          <Text size="sm">{text.label}</Text>
                          {reasonLabel(event.reasonCode) && (
                            <Badge size="sm" variant="light" color="gray">
                              {reasonLabel(event.reasonCode)}
                            </Badge>
                          )}
                        </Group>
                        {text.comment && (
                          <Text size="sm" c="dimmed" className="whitespace-pre-line break-words">
                            {text.comment}
                          </Text>
                        )}
                        <Text size="xs" c="dimmed">
                          {formatDate(event.createdAt, 'MMM D, YYYY h:mm A')}
                        </Text>
                      </Stack>
                    </Group>
                  );
                })}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
