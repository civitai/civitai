import { Text } from '@mantine/core';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';

/** "Inspired by @creator's image": one wording for the start modal and the story page. */
export function StorylineSparkCreditText({ username }: { username: string | null }) {
  return (
    <Text size="sm">
      Inspired by{' '}
      {username ? (
        <Text span fw={600}>
          @{username}&apos;s
        </Text>
      ) : (
        'this'
      )}{' '}
      image
    </Text>
  );
}

/**
 * The image a storyline started from, above chapter 1, linking to it. The server sends no spark
 * when this reader may not see it.
 */
export function StorylineSparkCredit({
  spark,
  className = 'mb-3.5',
}: {
  spark: { image: StorylineThumbImage; user: { username: string | null } };
  className?: string;
}) {
  return (
    <Link
      href={`/images/${spark.image.id}`}
      className={clsx(
        'flex items-center gap-3 rounded-md text-inherit no-underline hover:opacity-90',
        className
      )}
      data-testid="storyline-spark-credit"
    >
      <StorylineThumb image={spark.image} width={48} className="shrink-0 rounded" />
      <StorylineSparkCreditText username={spark.user.username} />
    </Link>
  );
}
