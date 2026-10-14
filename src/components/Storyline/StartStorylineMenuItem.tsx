import { Menu } from '@mantine/core';
import { IconBooks } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StartStorylineModal } from '~/components/Storyline/StartStorylineModal';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { useStorylineForPost } from '~/components/Storyline/storyline.utils';

export type StorylineSourcePost = {
  id: number;
  title?: string | null;
  nsfwLevel: number;
  publishedAt?: Date | null;
};

/** Owner-only: published posts that are not already a chapter can start a storyline. */
export function StartStorylineMenuItem({ post }: { post: StorylineSourcePost }) {
  const router = useRouter();
  const { storyline, isLoading } = useStorylineForPost(post.id);
  if (isLoading) return null;

  if (storyline)
    return (
      <Menu.Item
        leftSection={<IconBooks size={14} stroke={1.5} />}
        onClick={() => router.push(storylineUrl(storyline.storylineId))}
      >
        Open storyline
      </Menu.Item>
    );

  return (
    <Menu.Item
      leftSection={<IconBooks size={14} stroke={1.5} />}
      onClick={() =>
        dialogStore.trigger({
          component: StartStorylineModal,
          props: { postId: post.id, postTitle: post.title, postNsfwLevel: post.nsfwLevel },
        })
      }
    >
      Make this chapter 1 of a storyline
    </Menu.Item>
  );
}
