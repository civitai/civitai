import { Alert, Badge, Button, Center, Container, Loader, Text, Title } from '@mantine/core';
import { IconBook2 } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { StorylineCover } from '~/components/Storyline/StorylineCover';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import type { StorylineChapterRank } from '~/shared/utils/storyline';
import { trpc } from '~/utils/trpc';

const rankLabel: Record<StorylineChapterRank, string> = {
  canon: 'Main path',
  endorsed: 'Endorsed',
  community: 'Community',
};

export function StorylinePage({ id }: { id: number }) {
  const storylineQuery = trpc.storyline.getById.useQuery({ id });
  const storyline = storylineQuery.data;
  const rootChapterId = storyline?.rootChapterId ?? null;
  const chapterQueryInput = { chapterId: rootChapterId ?? 0 };
  const { data: rootPath } = trpc.storyline.getPath.useQuery(chapterQueryInput, {
    enabled: !!rootChapterId,
  });
  const { data: continuations = [] } = trpc.storyline.getChildren.useQuery(chapterQueryInput, {
    enabled: !!rootChapterId,
  });

  if (storylineQuery.isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!storyline)
    return (
      <Container size="sm" py="xl">
        <Alert color="gray">
          This storyline doesn&apos;t exist or isn&apos;t available to you.
        </Alert>
      </Container>
    );

  const firstChapter = rootPath?.chapters.find((chapter) => chapter.chapterId === rootChapterId);
  const rootPost = firstChapter?.post ?? null;
  const ratingLabel =
    browsingLevelLabels[storyline.maxNsfwLevel as keyof typeof browsingLevelLabels];

  return (
    <Container size="md" py="md" className="flex flex-col gap-4">
      <StorylineCover postId={rootPost?.id ?? null} title={storyline.title} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge color={storyline.status === 'Complete' ? 'gray' : 'green'} variant="light">
          {storyline.status}
        </Badge>
        {ratingLabel && <Badge variant="outline">Rated up to {ratingLabel}</Badge>}
        <Text size="sm" c="dimmed">
          by{' '}
          <Text component={Link} href={`/user/${storyline.user.username}`} size="sm" inherit>
            {storyline.user.username}
          </Text>
        </Text>
      </div>

      <div className="flex flex-wrap gap-2">
        {rootPost && (
          <Button component={Link} href={`/posts/${rootPost.id}`} leftSection={<IconBook2 />}>
            Read from the start
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        <section className="flex flex-[2] flex-col gap-2">
          <Title order={3}>Chapters</Title>
          <ol className="flex list-none flex-col gap-2 border-l-2 border-blue-5 pl-4">
            <li>
              {rootPost ? (
                <Text component={Link} href={`/posts/${rootPost.id}`} fw={600}>
                  1. {rootPost.title || 'Chapter 1'}
                </Text>
              ) : (
                <Text c="dimmed">1. This chapter isn&apos;t available</Text>
              )}
            </li>
            {continuations.length > 0 && (
              <li className="flex flex-col gap-1">
                <Text size="sm" c="dimmed">
                  {continuations.length === 1
                    ? '1 way to continue'
                    : `${continuations.length} ways to continue`}
                </Text>
                {continuations.map((chapter) => (
                  <div key={chapter.chapterId} className="flex items-center gap-2">
                    {chapter.post ? (
                      <Text component={Link} href={`/posts/${chapter.post.id}`} size="sm">
                        2. {chapter.post.title || 'Chapter 2'}
                        <Text span size="xs" c="dimmed">
                          {' '}
                          by {chapter.post.username}
                        </Text>
                      </Text>
                    ) : (
                      <Text size="sm" c="dimmed">
                        2. This chapter isn&apos;t available
                      </Text>
                    )}
                    <Badge size="xs" variant="light">
                      {rankLabel[chapter.rank]}
                    </Badge>
                  </div>
                ))}
              </li>
            )}
          </ol>
        </section>

        <section aria-labelledby="storyline-contributors" className="flex flex-1 flex-col gap-2">
          <Title order={3} id="storyline-contributors">
            Contributors
          </Title>
          <div className="flex items-center gap-2">
            <UserAvatarSimple id={storyline.user.id} username={storyline.user.username} />
            <Badge size="xs">Creator</Badge>
          </div>
          {storyline.collaborators.map((user) => (
            <div key={user.id} className="flex items-center gap-2">
              <UserAvatarSimple id={user.id} username={user.username} />
              <Badge size="xs" variant="light">
                Endorsed
              </Badge>
            </div>
          ))}
        </section>
      </div>

      {rootPost && (
        <section>
          <PostComments postId={rootPost.id} userId={storyline.user.id} />
        </section>
      )}
    </Container>
  );
}
