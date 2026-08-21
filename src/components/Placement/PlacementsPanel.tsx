import { Container, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import { QueueCountBadge } from '~/components/Placement/QueueCountBadge';
import { RemixSubmissionQueue } from '~/components/Placement/RemixSubmissionQueue';
import { StickerPlacementQueue } from '~/components/Placement/StickerPlacementQueue';
import {
  isPlacementSurfaceTab,
  PLACEMENT_SURFACE_TABS,
  type PlacementSurfaceTab,
} from '~/components/Placement/queue-routes';

/**
 * Everything waiting on this creator, in one place.
 *
 * Stickers and remixes were two pages — `/user/sticker-placements` and
 * `/user/remix-submissions` — that were the same job twice: the same `Placement`
 * table, the same pending/expiry mechanics, the same received/placed split, and
 * two separate things to remember to go and look at. Neither was reachable from
 * anywhere except account settings, which is most of why 96 placements sat
 * unanswered on prod while the feature was selling.
 *
 * So: one route, one thing to find. The surface is a segmented control rather
 * than a second row of tabs because it selects *which queue you are in*, not
 * which half of one — and it carries each surface's received count, so the
 * answer to "is there anything for me" is legible without switching.
 *
 * Both old routes redirect here, because a notification sent last week is a
 * link someone will click next month.
 */
export function PlacementsPanel() {
  const router = useRouter();
  const { pendingStickerPlacements, pendingRemixSubmissions } = useQueryNotificationsCount();

  const surface: PlacementSurfaceTab = isPlacementSurfaceTab(router.query.type)
    ? router.query.type
    : 'sticker';

  const setSurface = (value: string) =>
    router.replace(
      {
        // `tab` is deliberately dropped when the surface changes: received/placed
        // mean the same thing on both, but a count badge that came from the
        // other queue would be read as this one's.
        query: { ...router.query, type: isPlacementSurfaceTab(value) ? value : 'sticker' },
      },
      undefined,
      { shallow: true }
    );

  const counts: Record<PlacementSurfaceTab, number> = {
    sticker: pendingStickerPlacements,
    remix: pendingRemixSubmissions,
  };

  return (
    <>
      <Meta title="Your placements" deIndex />
      <Container size="md" my="md">
        <Stack gap="md">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <Title order={2}>Placements</Title>
              <Text size="sm" c="dimmed">
                What is waiting on your images, and what you have sent to other creators&apos;.
              </Text>
            </div>

            <SegmentedControl
              value={surface}
              onChange={setSurface}
              data={PLACEMENT_SURFACE_TABS.map((option) => ({
                value: option.value,
                label: (
                  <span className="flex items-center gap-1.5">
                    {option.label}
                    <QueueCountBadge count={counts[option.value]} max={99} />
                  </span>
                ),
              }))}
            />
          </div>

          {/* Each queue keeps its own received/placed tabs, its own queries and
              its own row rendering — this page decides which one you are
              looking at and nothing else. Unifying the shell was the point;
              unifying the rows would have been a rewrite of two working
              surfaces. */}
          {surface === 'sticker' ? <StickerPlacementQueue /> : <RemixSubmissionQueue />}
        </Stack>
      </Container>
    </>
  );
}
