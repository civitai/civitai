import { Anchor, Menu, Text } from '@mantine/core';
import { IconArrowLeft, IconBook2, IconPhoto } from '@tabler/icons-react';
import Router from 'next/router';
import { useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StorylineEndOfChapter } from '~/components/Storyline/StorylineEndOfChapter';
import { StorylinePill } from '~/components/Storyline/StorylinePill';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';
import {
  useHiddenUserIds,
  useStorylinePath,
  useStorylinesEnabled,
  useStorylineTracking,
} from '~/components/Storyline/storyline.queries';
import {
  hideHiddenUsersChapters,
  routeVia,
  storylineChapterLink,
} from '~/components/Storyline/storyline-mode.utils';
import { getStorylinePostParents } from '~/components/Storyline/storyline-post.utils';
import { storylineChapterLinkProps } from '~/components/Storyline/storyline-read-link';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

function useStorylinePostChapter(postId: number) {
  const enabled = useStorylinesEnabled();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  // The same read as image detail's entry chip, so the two share a cache entry.
  const { data } = trpc.storyline.getForPosts.useQuery(
    { postIds: [postId], browsingLevel },
    { enabled, staleTime: 60_000 }
  );
  const entry = data?.[postId];
  const pathQuery = useStorylinePath(entry?.chapterId);
  const hiddenUserIds = useHiddenUserIds();
  const path = useMemo(() => {
    // keepPreviousData: a path read for another post's chapter must not show here.
    const data = pathQuery.data;
    const end = data?.chapters[data.chapters.length - 1];
    if (!data || !entry || end?.chapterId !== entry.chapterId) return undefined;
    return {
      ...data,
      chapters: hideHiddenUsersChapters(data.chapters, hiddenUserIds).map((chapter) => ({
        ...chapter,
        joins: hideHiddenUsersChapters(chapter.joins, hiddenUserIds),
      })),
    };
  }, [pathQuery.data, entry, hiddenUserIds]);
  if (!entry) return null;
  return { entry, path, end: path?.chapters[path.chapters.length - 1] };
}

export function StorylinePostPill({ postId }: { postId: number }) {
  const chapter = useStorylinePostChapter(postId);
  if (!chapter) return null;
  const { entry, path, end } = chapter;
  const read = end && path && storylineChapterLink(end, routeVia(path.chapters));

  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <StorylinePill
          title={entry.title}
          // The stored number, as image detail's entry chip shows it for the same post.
          depth={entry.depth}
          menu
          className="mb-2 self-start"
        />
      </Menu.Target>
      <Menu.Dropdown>
        {read?.read && (
          <Menu.Item
            component="a"
            leftSection={<IconPhoto size={16} />}
            {...storylineChapterLinkProps(read)}
            data-testid="storyline-post-read"
          >
            Read from here in the viewer
          </Menu.Item>
        )}
        <Menu.Item
          component={Link}
          href={storylineUrl(entry.storylineId)}
          leftSection={<IconBook2 size={16} />}
          data-testid="storyline-post-story-page"
        >
          Story page and map
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** The post page only routes into the viewer: reading happens there, so a choice opens it. */
export function StorylinePostNext({ postId }: { postId: number }) {
  const chapter = useStorylinePostChapter(postId);
  const currentUser = useCurrentUser();
  const tracking = useStorylineTracking();
  if (!chapter?.path || !chapter.end) return null;
  const { entry, path, end } = chapter;
  const parents = getStorylinePostParents(path.chapters, path.storyline.userId);

  const onContinue = (child: StorylineChild & { firstImage?: { id: number } | null }) => {
    tracking.trackBranchChoice({ fromChapterId: end.chapterId, toChapterId: child.chapterId });
    const link = storylineChapterLink(
      { ...child, firstImage: child.firstImage ?? null },
      routeVia([...path.chapters, child])
    );
    // A way on this reader cannot see the start of: the story page shows what follows it.
    if (!link) return Router.push(storylineUrl(path.storyline.id));
    if (!link.read) return Router.push(link.href);
    triggerRoutedDialog({
      name: 'imageDetail',
      state: {
        imageId: link.read.imageId,
        storylineChapterId: link.read.chapterId,
        storylineVia: link.read.via,
      },
    });
  };

  return (
    <section aria-label="What happens next" className="flex flex-col gap-3">
      <StorylineEndOfChapter
        layout="section"
        chapterId={end.chapterId}
        storylineId={path.storyline.id}
        chapterDepth={entry.depth}
        chapterTombstone={end.tombstone}
        parentPostId={end.post?.id}
        isOwner={!!currentUser && currentUser.id === path.storyline.userId}
        onMain={end.onMain}
        onContinue={onContinue}
      />
      <Text
        component="div"
        size="sm"
        className="flex flex-wrap items-center gap-x-4 gap-y-1"
        data-testid="storyline-post-ways-back"
      >
        {parents.length > 0 && (
          <span className="flex flex-wrap items-center gap-1" data-testid="storyline-post-previous">
            <IconArrowLeft size={14} />
            {parents.length > 1 ? 'Came from:' : 'Previous:'}
            {parents.map((parent, i) => (
              <span key={parent.chapterId}>
                {i > 0 && ' or '}
                {parent.href ? (
                  <Anchor component={Link} href={parent.href} inherit>
                    {parent.name}
                  </Anchor>
                ) : (
                  parent.name
                )}{' '}
                <Text span c="dimmed" inherit>
                  ({parent.where})
                </Text>
              </span>
            ))}
          </span>
        )}
        <Anchor component={Link} href={storylineUrl(path.storyline.id)} inherit>
          Story map
        </Anchor>
      </Text>
    </section>
  );
}
