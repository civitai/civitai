import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { ImageWidth } from '~/shared/tiptap/image-width';
import classes from './GuardedBodyMedia.module.scss';

/** A content image as `getArticleById` returns it: the Image row the body's url was linked to. */
export type BodyImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  userId: number;
  hash: string | null;
  width: number | null;
  height: number | null;
};

/** `nsfwLevel` stands in for any body image with no linked row. */
export type BodyImageGuard = { images: BodyImage[]; nsfwLevel: number };

/** Negative so it never names a real image; two unlinked copies of one url reveal together. */
function unlinkedImageId(key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return -(Math.abs(hash) + 1);
}

/**
 * An article body image or video under the site's standard guard: outside the reader's level it is
 * covered with "This image is rated …" and a Show button, and the media itself is not rendered
 * until Show.
 */
export function GuardedBodyMedia({
  linked,
  urlKey,
  fallbackNsfwLevel,
  size,
  children,
}: {
  linked: BodyImage | undefined;
  urlKey: string;
  fallbackNsfwLevel: number;
  size?: ImageWidth | null;
  children: React.ReactElement;
}) {
  const image = linked ?? { id: unlinkedImageId(urlKey), nsfwLevel: fallbackNsfwLevel };
  const width = linked?.width ?? null;
  const height = linked?.height ?? null;

  return (
    <div className={classes.root} data-width={size ?? undefined}>
      <ImageGuard2 image={image}>
        {(show) => (
          <>
            {linked && <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />}
            {show ? (
              children
            ) : (
              <div
                className={classes.placeholder}
                style={{
                  width: width ? `${width}px` : '100%',
                  aspectRatio: width && height ? `${width} / ${height}` : '4 / 3',
                }}
              >
                {linked && <MediaHash {...linked} />}
              </div>
            )}
          </>
        )}
      </ImageGuard2>
    </div>
  );
}
