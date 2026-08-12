import { HoverCard, Skeleton, Stack } from '@mantine/core';
import dynamic from 'next/dynamic';
import type { ReactElement } from 'react';
import { createContext, useContext } from 'react';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { trpc } from '~/utils/trpc';

// Loaded with the hover, not with the page. The creator card drags in profile
// cosmetics, live metrics and edge media, and a feed renders dozens of avatars
// that nobody hovers.
const SmartCreatorCard = dynamic(() =>
  import('~/components/CreatorCard/CreatorCard').then((m) => m.SmartCreatorCard)
);

/**
 * Wide enough that the creator card's top row never wraps — rank badge, up to
 * three stat badges and the cosmetic badge need about 385px. Matches the width
 * the sticker placement hover card settled on.
 */
export const HOVER_CARD_WIDTH = 400;

export const HOVER_DELAY_MS = 500;

const NestedContext = createContext(false);

/**
 * Peek at a creator without leaving the page.
 *
 * The dropdown suppresses hover cards rendered inside it, because the creator
 * card renders a `UserAvatar` of its own and would otherwise offer to open the
 * same card again on top of itself.
 */
export function UserHoverCard({
  user,
  children,
}: {
  user: Pick<Partial<UserWithCosmetics>, 'id' | 'deletedAt'>;
  children: ReactElement;
}) {
  const nested = useContext(NestedContext);
  const userId = user.id;

  if (nested || !userId || userId < 1 || !!user.deletedAt) return children;

  return (
    <HoverCard
      width={HOVER_CARD_WIDTH}
      shadow="sm"
      withArrow
      withinPortal
      openDelay={HOVER_DELAY_MS}
      closeDelay={100}
      position="bottom-start"
      offset={4}
    >
      <HoverCard.Target>{children}</HoverCard.Target>
      {/* The creator card carries its own padding and fills the dropdown edge to
          edge. Its border is dropped rather than the dropdown's, so there is one
          outline instead of two nested ones a pixel apart. */}
      <HoverCard.Dropdown p={0} className="overflow-hidden">
        <NestedContext.Provider value={true}>
          <HoverCreatorCard userId={userId} />
        </NestedContext.Provider>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/**
 * The creator card with its empty state held back.
 *
 * Given only an id it renders zeroed stats and a `[deleted]` name until its own
 * `getCreator` query lands — fine on a page, wrong in a dropdown that opens
 * already populated. This runs the same query first (so the card's is a cache
 * hit) and shows the card only once there is something to show.
 *
 * A username-only mention costs the id lookup here too.
 */
export function HoverCreatorCard({
  userId,
  username,
}: {
  userId?: number | null;
  username?: string | null;
}) {
  const { data, isLoading } = trpc.user.getCreator.useQuery(
    userId ? { id: userId } : { username: username as string },
    { enabled: !!userId || !!username, staleTime: 5 * 60_000 }
  );

  const id = userId ?? data?.id;
  if (isLoading || !id) return <CreatorCardSkeleton />;

  return <SmartCreatorCard user={{ id }} withBorder={false} />;
}

/**
 * Shaped like the card it stands in for — banner, avatar, name, stat row — so
 * the dropdown doesn't resize under the cursor when the data lands, which on a
 * hover card can move the target out from under you.
 */
function CreatorCardSkeleton() {
  return (
    <Stack gap={0}>
      <Skeleton height={80} radius={0} />
      <div className="flex items-center gap-3 p-3">
        <Skeleton height={60} circle />
        <Stack gap={6} className="flex-1">
          <Skeleton height={14} width="55%" />
          <Skeleton height={10} width="35%" />
        </Stack>
      </div>
    </Stack>
  );
}
