import { Button } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { StorylineAuthorEdit } from '~/components/Storyline/StorylineAuthorEdit';
import { StorylineCaptionNote } from '~/components/Storyline/StorylineCaptionNote';
import { StorylineEndOfChapter } from '~/components/Storyline/StorylineEndOfChapter';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { StorylineMapControl } from '~/components/Storyline/StorylineMap';
import { StorylineEntryChip } from '~/components/Storyline/StorylinePill';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/** The chapter on screen: a text slide's by its own post, since its URL may name another chapter's image. */
function chapterPosition(storyline: ActiveStorylineMode, imageId: number, textPostId?: number) {
  const chapterId = textPostId
    ? storyline.chapterIdOfPost(textPostId)
    : storyline.chapterIdOfImage(imageId);
  const chapter = storyline.path.chapters.find((c) => c.chapterId === chapterId);
  return { chapterId, depth: chapter?.depth, post: chapter?.post };
}

/**
 * The storyline's place in the stage toolbar: in the mode, the chip the map drops from; outside
 * it, the invitation to read the post's storyline. Desktop puts it after Save, a phone after the
 * close button, so each layout mounts exactly one.
 */
export function StorylineToolbarChip({
  imageId,
  postId,
  textPostId,
  placement,
}: {
  imageId: number;
  postId: number | null;
  /** On a text slide, the text's post. */
  textPostId?: number;
  placement: 'toolbar' | 'mobile';
}) {
  const storyline = useStorylineMode();
  // The same test as the slots' `@md:hidden` / `@max-md:hidden`: the stage container under md.
  // A viewport check at sm leaves a band of widths with neither chip.
  const narrowStage = useIsMobile({ breakpoint: 'md' });
  if (narrowStage !== (placement === 'mobile')) return null;
  if (!storyline.active)
    return <StorylineEntryPill postId={postId} compact={placement === 'mobile'} />;
  const { chapterId, depth } = chapterPosition(storyline, imageId, textPostId);
  const end = storyline.path.chapters[storyline.path.chapters.length - 1];
  return (
    <StorylineMapControl
      storyline={storyline}
      currentChapterId={chapterId}
      depth={depth ?? end.depth}
    />
  );
}

/** The description of the image's chapter post, rendered as the post page does, clamped. */
export function StorylineChapterDescription({
  imageId,
  textPostId,
}: {
  imageId: number | undefined;
  textPostId?: number;
}) {
  const storyline = useStorylineMode();
  const postId =
    storyline.active && imageId
      ? chapterPosition(storyline, imageId, textPostId).post?.id
      : undefined;
  const { data: post } = trpc.post.get.useQuery({ id: postId ?? 0 }, { enabled: !!postId });
  if (!postId || post?.id !== postId || !post.detail) return null;

  return (
    // Expanded, it scrolls instead of shrinking the image.
    <div className="max-h-[40vh] overflow-y-auto px-1" data-testid="storyline-chapter-description">
      <ContentClamp key={postId} maxHeight={72}>
        <RenderHtml html={post.detail} withMentions />
      </ContentClamp>
    </div>
  );
}

/**
 * Rendered over the carousel: the image's caption, the way on past the last image, and the fork
 * point.
 */
export function StorylineStageOverlay({
  isLastImage,
  imageId,
}: {
  isLastImage: boolean;
  imageId: number | undefined;
}) {
  const storyline = useStorylineMode();
  const currentUser = useCurrentUser();
  if (!storyline.active) return null;

  const end = storyline.path.chapters[storyline.path.chapters.length - 1];
  const caption = imageId ? storyline.path.captions[imageId] : undefined;
  const showNext = isLastImage && !storyline.endOpen;
  const post = imageId ? chapterPosition(storyline, imageId).post : undefined;
  const isAuthor = !!currentUser && !!post && currentUser.id === post.userId;
  const captionNote = caption && <StorylineCaptionNote key={imageId} caption={caption} hideable />;

  return (
    <>
      {(showNext || caption || isAuthor) && !storyline.endOpen && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-col items-end gap-2.5 @md:inset-x-4 @md:bottom-4 @md:items-center [&>*]:pointer-events-auto">
          {showNext && (
            <Button
              className="@md:self-end"
              radius="xl"
              variant="gradient"
              gradient={{ from: 'violet', to: 'blue', deg: 90 }}
              rightSection={<IconArrowRight size={16} />}
              onClick={() => storyline.setEndOpen(true)}
              data-testid="storyline-next"
            >
              What happens next
            </Button>
          )}
          {isAuthor && imageId ? (
            <StorylineAuthorEdit
              key={imageId}
              postId={post.id}
              title={post.title}
              imageId={imageId}
              caption={caption}
            >
              {captionNote}
            </StorylineAuthorEdit>
          ) : (
            captionNote
          )}
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
          onMain={end.onMain}
          onContinue={storyline.continueTo}
          onClose={() => storyline.setEndOpen(false)}
        />
      )}
    </>
  );
}

function StorylineEntryPill({ postId, compact }: { postId: number | null; compact: boolean }) {
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
    <StorylineEntryChip
      title={entry.title}
      depth={entry.depth}
      onEnter={() => storyline.enter(entry.chapterId)}
      compact={compact}
    />
  );
}
