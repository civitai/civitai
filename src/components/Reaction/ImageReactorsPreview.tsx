import { ActionIcon, Anchor, HoverCard, Loader, Popover, Stack, Text } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { HOVER_CARD_Z_INDEX, useHoverCapable } from '~/components/UserAvatar/UserHoverCard';
import { HOVER_CLOSE_DELAY_MS, HOVER_DELAY_MS } from '~/components/UserAvatar/hover-card.constants';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { CREATOR_STUDIO_URL } from '~/shared/constants/creator-studio.constants';
import { trpc } from '~/utils/trpc';

const DROPDOWN_WIDTH = 280;

/**
 * Lets an image's owner see who reacted; everyone else gets the bar untouched and no request is ever made. Hover-capable
 * pointers get a hover card over the bar, touch gets a button beside it, because a tap on a reaction toggles it.
 */
export function ImageReactorsPreview({
  imageId,
  ownerId,
  children,
}: {
  imageId: number;
  ownerId: number;
  children: ReactNode;
}) {
  const currentUser = useCurrentUser();
  const hoverCapable = useHoverCapable();

  if (!currentUser || currentUser.id !== ownerId) return <>{children}</>;

  if (hoverCapable)
    return (
      <HoverCard
        width={DROPDOWN_WIDTH}
        shadow="md"
        withArrow
        withinPortal
        withRoles={false}
        zIndex={HOVER_CARD_Z_INDEX}
        openDelay={HOVER_DELAY_MS}
        closeDelay={HOVER_CLOSE_DELAY_MS}
        position="top"
      >
        <HoverCard.Target>
          <div>{children}</div>
        </HoverCard.Target>
        <HoverCard.Dropdown p="sm">
          <ImageReactorsList imageId={imageId} />
        </HoverCard.Dropdown>
      </HoverCard>
    );

  return (
    <div className="flex items-center gap-1">
      {children}
      <Popover width={DROPDOWN_WIDTH} shadow="md" withArrow withinPortal position="top">
        <Popover.Target>
          <ActionIcon variant="subtle" color="gray" radius="xl" aria-label="Who reacted">
            <IconUsers size={16} />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown p="sm">
          <ImageReactorsList imageId={imageId} />
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}

// Mounted only while a dropdown is open, which is what keeps the read off page load.
export function ImageReactorsList({ imageId }: { imageId: number }) {
  const { data, isLoading, isError } = trpc.reaction.getImageReactors.useQuery({ id: imageId });

  return (
    <Stack gap="xs">
      <div>
        <Text size="sm" fw={600}>
          Who reacted
        </Text>
        <Text size="xs" c="dimmed">
          Newest accounts first. Only you can see this.
        </Text>
      </div>
      {isLoading ? (
        <Loader size="sm" className="self-center" />
      ) : isError ? (
        <Text size="sm" c="dimmed">
          Couldn&apos;t load who reacted.
        </Text>
      ) : !data?.length ? (
        <Text size="sm" c="dimmed">
          No reactions yet.
        </Text>
      ) : (
        <Stack gap={6}>
          {data.map((reactor) => (
            <div key={reactor.userId} className="flex items-center justify-between gap-2">
              <UserAvatar
                user={{
                  id: reactor.userId,
                  username: reactor.username,
                  deletedAt: reactor.deletedAt,
                  profilePicture: reactor.profilePicture,
                  cosmetics: [],
                }}
                size="xs"
                withUsername
                linkToProfile={!reactor.deletedAt}
                withHoverCard={false}
                withDecorations={false}
              />
              <Text size="sm" className="shrink-0" aria-label={reactor.reactions.join(', ')}>
                {reactor.reactions.map((r) => constants.availableReactions[r]).join(' ')}
              </Text>
            </div>
          ))}
        </Stack>
      )}
      <Anchor
        href={`${CREATOR_STUDIO_URL}/analytics/content/image/${imageId}`}
        target="_blank"
        rel="noopener noreferrer"
        size="sm"
      >
        View all in Creator Studio
      </Anchor>
    </Stack>
  );
}
