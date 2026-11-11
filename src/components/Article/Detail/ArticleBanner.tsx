import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { ArticleGetById } from '~/server/services/article.service';
import { constants } from '~/server/common/constants';

type BannerImage = NonNullable<ArticleGetById['bannerImage']>;

const BANNER_ASPECT = constants.article.bannerImageWidth / constants.article.bannerImageHeight;

/** The full-width banner across the top of an article that has one. */
export function ArticleBanner({
  image,
  articleId,
  title,
}: {
  image: BannerImage;
  articleId: number;
  title: string;
}) {
  return (
    <div
      className="relative mb-6 max-h-[28rem] w-full overflow-hidden"
      style={{ aspectRatio: BANNER_ASPECT }}
      data-testid="article-banner"
    >
      <ImageGuard2 image={image} connectType="article" connectId={articleId}>
        {(safe) => (
          <RoutedDialogLink
            name="imageDetail"
            state={{ imageId: image.id }}
            className="block size-full cursor-pointer"
          >
            <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
            <ImageContextMenu image={image} noDelete className="absolute right-2 top-2 z-10" />
            {!safe ? (
              <div className="relative size-full overflow-hidden">
                <MediaHash {...image} />
              </div>
            ) : (
              <EdgeMedia
                src={image.url}
                className="size-full object-cover"
                // EdgeImage caps an image at its requested width; the banner must span any screen.
                style={{ maxWidth: 'none' }}
                name={image.name}
                alt={title}
                type={image.type}
                width={constants.article.bannerImageWidth}
                anim={safe}
              />
            )}
          </RoutedDialogLink>
        )}
      </ImageGuard2>
    </div>
  );
}
