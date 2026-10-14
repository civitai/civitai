import { Button } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { StorylineDrawer } from '~/components/Storyline/StorylineDrawer';
import { StorylineEndOfChapter } from '~/components/Storyline/StorylineEndOfChapter';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { StorylineEntryChip, StorylineModeChip } from '~/components/Storyline/StorylinePill';
import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

function chapterPosition(storyline: ActiveStorylineMode, imageId: number) {
  const chapterId = storyline.chapterIdOfImage(imageId);
  const chapter = storyline.path.chapters.find((c) => c.chapterId === chapterId);
  return { chapterId, depth: chapter?.depth };
}

/**
 * Rendered over the carousel: the storyline chip (the only storyline chrome in image detail), the
 * way on past the last image, the fork point.
 */
export function StorylineStageOverlay({
  imageId,
  postId,
  isLastImage,
}: {
  imageId: number;
  postId: number | null;
  isLastImage: boolean;
}) {
  const storyline = useStorylineMode();
  const currentUser = useCurrentUser();
  if (!storyline.active) return <StorylineEntryPill postId={postId} />;

  const { chapterId, depth } = chapterPosition(storyline, imageId);
  const end = storyline.path.chapters[storyline.path.chapters.length - 1];

  return (
    <>
      {/* Above the end-of-chapter card too, so the map and leaving stay one tap away there. */}
      <div className="absolute left-3 top-3 z-30">
        <StorylineModeChip
          title={storyline.path.storyline.title}
          depth={depth ?? end.depth}
          onOpenMap={() => storyline.setDrawerOpen(true)}
          onLeave={storyline.leave}
        />
      </div>
      {isLastImage && !storyline.endOpen && (
        <div className="absolute bottom-4 right-4 z-10">
          <Button
            radius="xl"
            variant="gradient"
            gradient={{ from: 'violet', to: 'blue', deg: 90 }}
            rightSection={<IconArrowRight size={16} />}
            onClick={() => storyline.setEndOpen(true)}
            data-testid="storyline-next"
          >
            What happens next
          </Button>
        </div>
      )}
      {storyline.endOpen && (
        <StorylineEndOfChapter
          chapterId={end.chapterId}
          storylineId={storyline.path.storyline.id}
          chapterDepth={end.depth}
          chapterTombstone={end.tombstone}
          parentPostId={end.post?.id}
          isOwner={!!currentUser && currentUser.id === storyline.path.storyline.userId}
          onContinue={storyline.continueTo}
          onClose={() => storyline.setEndOpen(false)}
        />
      )}
      <StorylineDrawer storyline={storyline} currentChapterId={chapterId} />
    </>
  );
}

/** Outside storyline mode: says the image is part of a storyline and offers to read it as one. */
function StorylineEntryPill({ postId }: { postId: number | null }) {
  const enabled = useStorylinesEnabled();
  const storyline = useStorylineMode();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const { data } = trpc.storyline.getForPosts.useQuery(
    { postIds: postId ? [postId] : [], browsingLevel },
    { enabled: enabled && !!postId, staleTime: 60_000 }
  );
  const entry = postId ? data?.[postId] : undefined;
  if (!entry) return null;

  return (
    <div className="absolute left-3 top-3 z-10">
      <StorylineEntryChip
        title={entry.title}
        depth={entry.depth}
        onEnter={() => storyline.enter(entry.chapterId)}
      />
    </div>
  );
}
