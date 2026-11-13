import { AspectRatio, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import { useMemo } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Gated } from '~/components/Gated/Gated';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { RenderRichText } from '~/components/RichTextEditor/RenderRichText';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import type { SharedArticle } from '~/server/services/article-share.service';
import { formatDate } from '~/utils/date-helpers';
import { removeSpoilers } from '~/utils/html-sanitize-helpers';
import { removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

/** The read-only view of a draft opened through its share link. */
export function SharedArticleView({ article }: { article: SharedArticle }) {
  const coverImages = useMemo(() => [article.coverImage].filter(isDefined), [article.coverImage]);
  const { items } = useApplyHiddenPreferences({ type: 'images', data: coverImages });
  const [image] = items;

  return (
    <Gated
      contentNsfwLevel={article.nsfwLevel}
      suppressAds
      meta={{
        title: `${article.title} | Draft preview | Civitai`,
        description: removeTags(removeSpoilers(article.content ?? '')).slice(0, 150),
        deIndex: true,
      }}
    >
      <Container size="md">
        <Stack gap="md" my="xl">
          <AlertWithIcon icon={<IconEye />} color="blue" iconColor="blue" size="lg">
            Draft preview — shared by the author. This article isn&apos;t published.
          </AlertWithIcon>
          <Title order={1}>{article.title}</Title>
          <Group gap={8}>
            <UserAvatar user={article.user} withUsername linkToProfile />
            <Divider orientation="vertical" />
            <Text c="dimmed" size="sm">
              Draft, last edited {formatDate(article.updatedAt)}
            </Text>
          </Group>
          {image && (
            <AspectRatio
              ratio={constants.article.coverImageWidth / constants.article.coverImageHeight}
            >
              <div className="relative size-full">
                <ImageGuard2 image={image} connectType="article" connectId={article.id}>
                  {(safe) => (
                    <div className="relative size-full">
                      <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                      {!safe ? (
                        <div className="relative h-full overflow-hidden rounded-lg object-cover">
                          <MediaHash {...image} />
                        </div>
                      ) : (
                        <EdgeMedia
                          src={image.url}
                          className="h-full rounded-lg object-cover"
                          name={image.name}
                          alt={article.title}
                          type={image.type}
                          width={1320}
                          anim={safe}
                        />
                      )}
                    </div>
                  )}
                </ImageGuard2>
              </div>
            </AspectRatio>
          )}
          {article.contentJson && (
            <article>
              <RenderRichText
                content={article.contentJson}
                fallbackHtml={article.content}
                imageGuard={{ images: article.contentImages, nsfwLevel: article.nsfwLevel }}
              />
            </article>
          )}
          <Divider />
          <Text size="sm" c="dimmed">
            Comments you leave are visible to the author and other link holders, and stay on the
            article if it is published.
          </Text>
          <ArticleDetailComments articleId={article.id} userId={article.user.id} />
        </Stack>
      </Container>
    </Gated>
  );
}
