import { Alert, Badge, Button, Center, Container, Loader, Text, Title } from '@mantine/core';
import { IconBook2, IconPencilPlus, IconSettings } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { openStorylineContinueModal } from '~/components/Storyline/continue/openStorylineContinueModal';
import { openStorylineManageModal } from '~/components/Storyline/manage/openStorylineManageModal';
import { StorylineCover } from '~/components/Storyline/StorylineCover';
import { useStorylineContinueTerms } from '~/components/Storyline/storyline.queries';
import { storylinePriceLabel } from '~/components/Storyline/storyline-ui';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

const roleLabel = { creator: 'Creator', endorsed: 'Endorsed', contributor: 'Contributor' } as const;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function StorylinePage({ id }: { id: number }) {
  const storylineQuery = trpc.storyline.getById.useQuery({ id });
  const storyline = storylineQuery.data;
  const mainPath = storyline?.mainPath ?? [];
  // Cover, thread and Read from the start come from the reading path, which tombstones chapter 1
  // where this reader may not see it; `rootPostId` does not.
  const rootPost = mainPath[0]?.post ?? null;
  // A continuation is added at the end of the main path, after its last chapter this reader can see.
  const lastPost = [...mainPath].reverse().find((chapter) => chapter.post)?.post ?? null;
  const terms = useStorylineContinueTerms(lastPost?.id);

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

  const ratingLabel =
    browsingLevelLabels[storyline.maxNsfwLevel as keyof typeof browsingLevelLabels];

  return (
    <Container size="md" py="md" className="flex flex-col gap-4">
      <StorylineCover postId={rootPost?.id ?? null} title={storyline.title} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge color={storyline.status === 'Complete' ? 'gray' : 'green'} variant="light">
          {storyline.status}
        </Badge>
        {terms?.open && (
          <Badge color="violet" variant="light">
            Open for continuations
          </Badge>
        )}
        <Badge variant="outline" color="gray">
          {plural(storyline.chapterCount, 'chapter', 'chapters')} ·{' '}
          {plural(storyline.contributorCount, 'creator', 'creators')}
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
        {lastPost && terms?.open && (
          <Button
            variant="light"
            leftSection={<IconPencilPlus />}
            onClick={() => openStorylineContinueModal({ parentPostId: lastPost.id })}
          >
            Continue the story · {storylinePriceLabel(terms.price)}
          </Button>
        )}
        {storyline.viewerRole === 'owner' && (
          <Button
            variant="default"
            leftSection={<IconSettings />}
            onClick={() => openStorylineManageModal({ storylineId: storyline.id })}
          >
            Manage
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        <section aria-labelledby="storyline-main-path" className="flex flex-[2] flex-col gap-2">
          <Title order={3} id="storyline-main-path">
            Main path
          </Title>
          <ol className="flex list-none flex-col gap-2 border-l-2 border-blue-5 pl-4">
            {mainPath.map((chapter) => (
              <li key={chapter.chapterId} className="flex flex-wrap items-center gap-2">
                {chapter.post ? (
                  <Text component={Link} href={`/posts/${chapter.post.id}`} size="sm">
                    {chapter.depth + 1}. {chapter.post.title || `Chapter ${chapter.depth + 1}`}
                    <Text span size="xs" c="dimmed">
                      {' '}
                      by {chapter.post.username}
                    </Text>
                  </Text>
                ) : (
                  <Text size="sm" c="dimmed">
                    {chapter.depth + 1}. This chapter isn&apos;t available
                  </Text>
                )}
                {chapter.childCount > 1 && (
                  <Badge size="xs" variant="light" color="violet">
                    {plural(chapter.childCount, 'way', 'ways')} to continue
                  </Badge>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="storyline-contributors" className="flex flex-1 flex-col gap-2">
          <Title order={3} id="storyline-contributors">
            Contributors
          </Title>
          {storyline.contributors.map(({ user, role }) => (
            <div key={user.id} className="flex items-center gap-2">
              <UserAvatarSimple id={user.id} username={user.username} />
              <Badge size="xs" variant={role === 'creator' ? 'filled' : 'light'}>
                {roleLabel[role]}
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
