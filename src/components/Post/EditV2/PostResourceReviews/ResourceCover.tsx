import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';

export type ResourceCoverImage = {
  id: number;
  userId: number;
  url: string;
  type: 'image' | 'video' | 'audio';
  nsfwLevel: number;
  width: number;
  height: number;
  hash: string;
  poi?: boolean;
  minor?: boolean;
};

/** A fixed-size square so the header and rail never shift whether or not a cover loads. */
export function ResourceCover({
  image,
  size,
}: {
  image: ResourceCoverImage | null | undefined;
  size: number;
}) {
  const box = 'relative shrink-0 overflow-hidden rounded-md bg-gray-2 dark:bg-dark-5';

  if (!image)
    return (
      <div
        data-testid="resource-cover-placeholder"
        className={box}
        style={{ width: size, height: size }}
      />
    );

  return (
    <div data-testid="resource-cover" className={box} style={{ width: size, height: size }}>
      {/* explain={false}: the default "rated X" overlay does not fit a thumbnail. */}
      <ImageGuard2 image={image} explain={false}>
        {(safe) =>
          safe ? (
            <EdgeMedia
              src={image.url}
              type={image.type}
              width={size * 2}
              alt=""
              className="size-full object-cover"
            />
          ) : (
            <MediaHash {...image} />
          )
        }
      </ImageGuard2>
    </div>
  );
}
