import { Anchor, Switch, Text } from '@mantine/core';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { StorylineSourcePost } from '~/components/Storyline/StartStorylineMenuItem';
import { StartStorylineModal } from '~/components/Storyline/StartStorylineModal';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { isPublished, useStorylineForPost } from '~/components/Storyline/storyline.utils';

/**
 * A storyline cannot be detached from its first chapter, so once the post is a chapter the switch
 * stays on and links to the storyline instead.
 */
export function StorylinePostEditorSwitch({ post }: { post: StorylineSourcePost }) {
  const published = isPublished(post);
  const { storyline, isLoading } = useStorylineForPost(post.id, { enabled: published });

  if (!published || isLoading) return null;

  return (
    <div className="flex flex-col gap-1">
      <Switch
        label={storyline ? 'Part of a storyline' : 'Make this chapter 1 of a storyline'}
        checked={!!storyline}
        disabled={!!storyline}
        onChange={(e) => {
          if (!e.currentTarget.checked) return;
          dialogStore.trigger({
            component: StartStorylineModal,
            props: { postId: post.id, postTitle: post.title, postNsfwLevel: post.nsfwLevel },
          });
        }}
      />
      {storyline && (
        <Text size="xs" c="dimmed">
          Chapter {storyline.depth + 1} of{' '}
          <Anchor component={Link} href={storylineUrl(storyline.storylineId)} size="xs">
            {storyline.title}
          </Anchor>
        </Text>
      )}
    </div>
  );
}
