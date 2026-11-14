import { Loader } from '@mantine/core';
import { BlurredText, TextPendingReview } from '~/components/Image/DetailV2/BlurredText';
import type { DetailText } from '~/components/Image/Detail/detail-items';
import { textGuardId } from '~/components/Image/Detail/detail-items';
import type { ConnectProps } from '~/components/ImageGuard/ImageGuard2';
import { ImageGuardContent } from '~/components/ImageGuard/ImageGuard2';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import articleBodyClasses from '~/components/RichTextEditor/ArticleBody.module.scss';
import { trpc } from '~/utils/trpc';

const PAGE =
  'my-auto w-full max-w-[680px] rounded-xl bg-white p-6 shadow-sm @md:p-10 dark:bg-dark-6';

/**
 * A storyline text item as a full-stage slide, in the article page's reading typography,
 * scrolling inside the slide. Path stubs carry no content; it comes from `post.get` for the
 * text's post.
 */
export function TextSlide({
  text,
  userId,
  ...connect
}: { text: DetailText; userId?: number } & ConnectProps) {
  const { data: post } = trpc.post.get.useQuery(
    { id: text.postId },
    { enabled: text.content === undefined }
  );
  const content =
    text.content ?? post?.texts.find((candidate) => candidate.id === text.id)?.content;

  return (
    <ImageGuardContent
      image={{ id: textGuardId(text.id), nsfwLevel: text.nsfwLevel, userId }}
      explainLabel="This text is rated"
      {...connect}
    >
      {(safe) => (
        <div
          className="flex size-full justify-center overflow-y-auto px-12 py-6 @md:px-16"
          data-testid="text-slide"
          data-text-id={text.id}
        >
          {!safe ? (
            <BlurredText className={PAGE} />
          ) : content === undefined ? (
            <Loader className="self-center" />
          ) : (
            <div className={PAGE}>
              <TextPendingReview nsfwLevel={text.nsfwLevel} />
              <RenderHtml html={content} className={articleBodyClasses.articleBody} withMentions />
            </div>
          )}
        </div>
      )}
    </ImageGuardContent>
  );
}
