import { Card, Text } from '@mantine/core';
import { IconLayoutList } from '@tabler/icons-react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';

/**
 * The image's post in the detail sidebar. In storyline mode the description is left out: the
 * reader shows it under the stage (`StorylineChapterDescription`).
 */
export function ImageDetailPostCard({
  post,
}: {
  post: { title: string | null; detail: string | null } | null | undefined;
}) {
  const storyline = useStorylineMode();
  const detail = storyline.active ? null : post?.detail;
  if (!post || !(post.title || detail)) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl" data-testid="image-detail-post-card">
      <Text className="flex items-center gap-2 text-xl font-semibold">
        <IconLayoutList />
        <span>{post.title}</span>
      </Text>
      {detail && (
        <ContentClamp maxHeight={75}>
          <RenderHtml html={detail} />
        </ContentClamp>
      )}
    </Card>
  );
}
