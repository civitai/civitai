import { Button, Center, Loader, Text } from '@mantine/core';
import clsx from 'clsx';
import { IconBooks, IconBrush } from '@tabler/icons-react';
import { RemixMenu, isRemixMenuVisible } from '~/components/Image/Remix/RemixMenu';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StorylineEditorBanner } from '~/components/Storyline/editor/StorylineEditorBanner';
import { storylineCardClass } from '~/components/Storyline/StorylineChips';
import { StorylineSparkCredit } from '~/components/Storyline/StorylineSparkCredit';
import type { StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * The storyline `/posts/create?storyline=` would start, and whether its first chapter is already
 * written. A storyline the viewer cannot read has no data: the server still has the last word.
 */
export function useStorylineToStart(storylineId?: number) {
  const { data, isLoading } = trpc.storyline.getById.useQuery(
    { id: storylineId ?? 0 },
    { enabled: !!storylineId }
  );
  return {
    storyline: data,
    loading: !!storylineId && isLoading,
    chapterOneWritten: !!data && data.rootChapterId != null,
  };
}

/**
 * A stale link (Back after publishing, an old tab) lands here with chapter 1 already written. The
 * server refuses a second one, so the upload is not offered: the way on is the storyline.
 */
function StorylineChapterOneWritten({ storyline }: { storyline: { id: number; title: string } }) {
  return (
    <section
      aria-label="Chapter 1 already written"
      className={clsx(storylineCardClass, 'flex flex-col gap-3 p-3')}
    >
      <div className="flex items-start gap-3">
        <IconBooks size={20} aria-hidden className="mt-0.5 shrink-0" />
        <Text size="sm">
          Chapter 1 of <b>{storyline.title}</b> is already written, so there is nothing to upload
          here. Open the storyline to read it or continue it.
        </Text>
      </div>
      <Button component={Link} href={storylineUrl(storyline.id)} variant="light" fullWidth>
        Open storyline
      </Button>
    </section>
  );
}

/**
 * The image a spark storyline started from, above the upload. Many who start one have no image of
 * their own, so a remixable spark offers a take on it, brought in through Import from Generator.
 */
function StorylineSparkStart({
  spark,
}: {
  spark: { image: StorylineThumbImage; user: { username: string | null } };
}) {
  const features = useFeatureFlags();
  // The spark payload lacks the fields RemixMenu's safety tiering reads, so it uses the full image.
  const { data: image } = trpc.image.get.useQuery(
    { id: spark.image.id },
    { enabled: !!features.imageGeneration }
  );
  const source =
    features.imageGeneration && image && image.url !== null && isRemixMenuVisible(image)
      ? image
      : null;

  return (
    <section
      aria-label="Your story starts from this image"
      className={clsx(storylineCardClass, 'flex flex-col gap-3 p-3')}
    >
      <StorylineSparkCredit spark={spark} className="" />
      {source && (
        <>
          <Text size="sm" c="dimmed">
            No image of your own yet? Make your take on this one, then add it with Import from
            Generator below.
          </Text>
          <RemixMenu image={source} source="remix:storyline-spark">
            <Button variant="light" fullWidth leftSection={<IconBrush size={16} />}>
              Remix this image
            </Button>
          </RemixMenu>
        </>
      )}
    </section>
  );
}

/**
 * Wraps what writes chapter 1 on `/posts/create?storyline=`: the banner and the upload, or the way
 * to the storyline once its first chapter exists. Without a storyline it is transparent.
 */
export function StorylineCreateGate({
  storylineId,
  children,
}: {
  storylineId?: number;
  children: React.ReactNode;
}) {
  const { storyline, loading, chapterOneWritten } = useStorylineToStart(storylineId);
  if (!storylineId) return <>{children}</>;
  // Held until the storyline is known, so an upload cannot start against a chapter 1 that exists.
  if (loading)
    return (
      <Center p="md">
        <Loader size="sm" aria-label="Loading storyline" />
      </Center>
    );
  if (storyline && chapterOneWritten) return <StorylineChapterOneWritten storyline={storyline} />;
  return (
    <>
      {storyline && (
        <StorylineEditorBanner
          variant="start"
          storyline={{ id: storyline.id, title: storyline.title }}
        />
      )}
      {storyline?.spark && <StorylineSparkStart spark={storyline.spark} />}
      {children}
    </>
  );
}
