import { Menu } from '@mantine/core';
import { IconBooks, IconPlaylistAdd } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { openAddToStorylineModal } from '~/components/Storyline/AddToStorylineModal';
import { openStartStorylineModal } from '~/components/Storyline/StartStorylineModal';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import type { StorylineSourcePost } from '~/components/Storyline/storyline.utils';
import { useStorylineForPost } from '~/components/Storyline/storyline.utils';

/**
 * The caller gates it to the owner of a published post; a post that is already a chapter opens its
 * storyline instead. Otherwise it starts a new storyline from the post, or adds it to one of theirs.
 */
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
    <>
      <Menu.Item
        leftSection={<IconBooks size={14} stroke={1.5} />}
        onClick={() => openStartStorylineModal(post)}
      >
        Make this chapter 1 of a storyline
      </Menu.Item>
      <Menu.Item
        leftSection={<IconPlaylistAdd size={14} stroke={1.5} />}
        onClick={() => openAddToStorylineModal(post)}
      >
        Add to a storyline
      </Menu.Item>
    </>
  );
}
