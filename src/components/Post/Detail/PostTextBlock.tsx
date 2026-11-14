import { Paper } from '@mantine/core';
import type { DetailText } from '~/components/Image/Detail/detail-items';
import { textGuardId } from '~/components/Image/Detail/detail-items';
import { BlurredText } from '~/components/Image/DetailV2/BlurredText';
import { ImageGuardContent } from '~/components/ImageGuard/ImageGuard2';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import articleBodyClasses from '~/components/RichTextEditor/ArticleBody.module.scss';
import { MAX_POST_IMAGES_WIDTH } from '~/server/common/constants';

/** A storyline text item read inline on the post page, between the images it sits among. */
export function PostTextBlock({
  text,
  postId,
  userId,
}: {
  text: DetailText;
  postId: number;
  userId?: number;
}) {
  return (
    <Paper
      radius="md"
      shadow="md"
      mx="auto"
      className="relative w-full overflow-hidden p-6 md:p-10"
      style={{ maxWidth: Math.min(MAX_POST_IMAGES_WIDTH, 760) }}
      data-testid="post-text-block"
      data-text-id={text.id}
    >
      <ImageGuardContent
        image={{ id: textGuardId(text.id), nsfwLevel: text.nsfwLevel, userId }}
        explainLabel="This text is rated"
        connectType="post"
        connectId={postId}
      >
        {(safe) =>
          safe && text.content ? (
            <RenderHtml
              html={text.content}
              className={articleBodyClasses.articleBody}
              withMentions
            />
          ) : (
            <BlurredText className="min-h-[160px]" />
          )
        }
      </ImageGuardContent>
    </Paper>
  );
}
