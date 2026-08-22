import { Alert, Button, Group, Loader, Text, Title } from '@mantine/core';
import { BackButton } from '~/components/BackButton/BackButton';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useState } from 'react';
import { StickerBookGrid } from '~/components/StickerBook/StickerBookGrid';
import type { StickerBookSide } from '~/components/StickerBook/sticker-book.util';
import { stickerBookSectionCopy } from '~/components/StickerBook/sticker-book.util';
import { trpc } from '~/utils/trpc';

/**
 * The "View all" behind one row of the book.
 *
 * A page rather than an expanded row, because it is the thing a creator lands on
 * from a link and has to be able to walk. It pages by offset — see the service
 * for why a cursor is not available on a grouped, max-ordered listing — and the
 * pages accumulate rather than replacing, so walking back up the feed does not
 * refetch what you already scrolled past.
 */
export function StickerBookSectionPage({
  username,
  side,
}: {
  username: string;
  side: StickerBookSide;
}) {
  // Sent for the same reason the tab sends it — see `StickerBookView`.
  const browsingLevel = useBrowsingLevelDebounced();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching } = trpc.stickerBook.getSection.useQuery(
    { username, side, page, browsingLevel },
    // The accumulated pages are what is on screen, so a page that is refetching
    // must keep showing the one before it rather than blanking the feed.
    { placeholderData: (previous) => previous }
  );

  if (isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );

  if (isError || !data)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load this. Refresh to try again.</Text>
      </Alert>
    );

  if (!data.access.canViewBook)
    return (
      <Alert color="gray">
        <Text size="sm">{username} keeps their sticker book private.</Text>
      </Alert>
    );

  const copy = stickerBookSectionCopy(side, { username, isOwner: data.isOwner });

  return (
    <div className="flex flex-col gap-4">
      {/* The shared back button rather than a link with an arrow glyph in it:
          it also goes back through history when there is history, so arriving
          from the tab returns to the scroll position it was left at. */}
      <div>
        <BackButton url={`/user/${username}/sticker-book`}>
          <Text size="sm">Back to the sticker book</Text>
        </BackButton>
        <Title order={2} mt={4}>
          {copy.title}
        </Title>
      </div>

      <StickerBookGrid items={data.items} side={side} />

      {/* Two different empty states, because `hasMore` is decided before the
          image filter runs: page 3 of a walk whose images were all unpublished
          is legitimately empty with a working Next button, and the
          nothing-here-yet copy would tell a creator with hundreds that they have
          none. */}
      {!data.items.length && (
        <Text size="sm" c="dimmed">
          {page > 1 ? 'Nothing on this page. Try the next one.' : copy.empty}
        </Text>
      )}

      <Group>
        {page > 1 && (
          <Button variant="default" onClick={() => setPage((current) => current - 1)}>
            Previous
          </Button>
        )}
        {data.hasMore && (
          <Button
            variant="default"
            loading={isFetching}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        )}
      </Group>
    </div>
  );
}
