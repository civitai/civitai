import { Grid, Stack, Title } from '@mantine/core';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import type {
  AvailableBlock,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';

/**
 * "Recently opened" marketplace section — a compact strip of the apps the
 * viewer most recently opened, sourced from localStorage (see
 * `recentlyOpenedApps.ts`) and resolved against the public listing.
 *
 * Split into a PURE presentational `RecentlyOpenedAppsView` (props-only, no
 * localStorage / no tRPC) so it renders in isolation for component tests; the
 * `/apps` page owns the localStorage read + the resolve-against-listing wiring
 * and passes the resolved `blocks` down.
 *
 * INVARIANT (tested): when `blocks` is empty the WHOLE section is hidden
 * (returns null) — a brand-new viewer with no recents sees nothing, not an
 * empty "Recently opened" header.
 */
export interface RecentlyOpenedAppsViewProps {
  /** The resolved recent apps, newest-first. Empty → the section is hidden. */
  blocks: AvailableBlock[];
  subsByBlock: Map<string, Partial<Record<SubscriptionScope, SubscriptionRecord>>>;
  onOpen: (block: AvailableBlock) => void;
  earningsByAppBlockId: Map<string, number>;
  canOpenPage: boolean;
}

export function RecentlyOpenedAppsView({
  blocks,
  subsByBlock,
  onOpen,
  earningsByAppBlockId,
  canOpenPage,
}: RecentlyOpenedAppsViewProps) {
  // Hide the entire section when there are no recents (new viewer).
  if (blocks.length === 0) return null;

  return (
    <Stack gap="xs" component="section" aria-label="Recently opened">
      <Title order={3}>Recently opened</Title>
      <Grid gutter="md">
        {blocks.map((block) => (
          <Grid.Col key={block.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
            <AppBlockCard
              block={block}
              alreadySubscribed={subsByBlock.has(block.id)}
              onOpen={onOpen}
              ownedEarningCents={earningsByAppBlockId.get(block.id)}
              canOpenPage={canOpenPage}
            />
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
}
