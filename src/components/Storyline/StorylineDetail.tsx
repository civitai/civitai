import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconChevronDown, IconMap2, IconX } from '@tabler/icons-react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { StorylineDrawer } from '~/components/Storyline/StorylineDrawer';
import { StorylineEndOfChapter } from '~/components/Storyline/StorylineEndOfChapter';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { StorylinePill, storylineChapterLabel } from '~/components/Storyline/StorylinePill';
import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { trpc } from '~/utils/trpc';

function chapterPosition(storyline: ActiveStorylineMode, imageId: number) {
  const chapterId = storyline.chapterIdOfImage(imageId);
  const chapter = storyline.path.chapters.find((c) => c.chapterId === chapterId);
  return { chapterId, depth: chapter?.depth };
}

export function StorylineBanner({ imageId }: { imageId: number }) {
  const storyline = useStorylineMode();
  if (!storyline.active) return null;

  const { depth } = chapterPosition(storyline, imageId);
  const where = storyline.endOpen
    ? 'End of chapter'
    : depth != null
    ? `Chapter ${depth + 1}`
    : undefined;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-white"
      style={{
        background:
          'linear-gradient(90deg, var(--mantine-color-violet-7), var(--mantine-color-blue-7))',
      }}
      data-testid="storyline-banner"
    >
      <Text size="sm" fw={700}>
        In a storyline
      </Text>
      <Text size="sm" className="min-w-0 flex-1 truncate">
        {storyline.path.storyline.title}
        {where ? ` · ${where}` : ''}
      </Text>
      <div className="flex gap-1">
        <Button
          size="compact-xs"
          variant="white"
          color="dark"
          leftSection={<IconMap2 size={14} />}
          onClick={() => storyline.setDrawerOpen(true)}
        >
          Where am I
        </Button>
        <Button
          size="compact-xs"
          variant="outline"
          color="gray.0"
          leftSection={<IconX size={14} />}
          onClick={storyline.leave}
        >
          Leave storyline
        </Button>
      </div>
    </div>
  );
}

/** Rendered over the carousel: the corner pill, the way on past the last image, the fork point. */
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
  if (!storyline.active) return <StorylineEntryPill postId={postId} />;

  const { chapterId, depth } = chapterPosition(storyline, imageId);
  const end = storyline.path.chapters[storyline.path.chapters.length - 1];

  return (
    <>
      <div className="absolute left-3 top-3 z-10">
        <StorylinePill
          title={storyline.path.storyline.title}
          depth={depth ?? end.depth}
          withTitle
          onClick={() => storyline.setDrawerOpen(true)}
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
          chapterTombstone={end.tombstone}
          parentPostId={end.post?.id}
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
      <Button
        size="compact-sm"
        radius="xl"
        color="violet"
        rightSection={<IconChevronDown size={14} />}
        onClick={() => storyline.enter(entry.chapterId)}
        data-testid="storyline-enter"
        aria-label={`Read the storyline ${entry.title} from chapter ${entry.depth + 1}`}
      >
        Storyline · {entry.title} · {storylineChapterLabel(entry.depth)} · Read
      </Button>
    </div>
  );
}
