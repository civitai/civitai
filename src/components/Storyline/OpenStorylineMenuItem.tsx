import { Menu } from '@mantine/core';
import { IconBooks } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import type { StorylineSourcePost } from '~/components/Storyline/storyline.utils';
import { useStorylineForPost } from '~/components/Storyline/storyline.utils';

/** The caller gates it to the owner of a published post. Only a post that is a chapter has one. */
export function OpenStorylineMenuItem({ post }: { post: StorylineSourcePost }) {
  const router = useRouter();
  const { storyline } = useStorylineForPost(post.id);
  if (!storyline) return null;

  return (
    <Menu.Item
      leftSection={<IconBooks size={14} stroke={1.5} />}
      onClick={() => router.push(storylineUrl(storyline.storylineId))}
    >
      Open storyline
    </Menu.Item>
  );
}
