import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';

/** The first image of chapter 1, through the normal image read so the viewer's level applies. */
export function StorylineCover({ postId, title }: { postId: number | null; title: string }) {
  const { images } = useQueryImages(
    { postId: postId ?? undefined, limit: 1, withMeta: false, include: [] },
    { enabled: !!postId }
  );
  const image = images[0];

  return (
    <div className="relative flex h-48 items-end overflow-hidden rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-600 sm:h-64">
      {image && (
        <ImageGuard2 image={image}>
          {(safe) => (
            <div className="absolute inset-0">
              <div className="absolute left-2 top-2 z-10">
                <ImageGuard2.BlurToggle />
              </div>
              {safe ? (
                <EdgeMedia
                  src={image.url}
                  type={image.type}
                  width={1200}
                  className="size-full object-cover"
                />
              ) : (
                <MediaHash {...image} />
              )}
            </div>
          )}
        </ImageGuard2>
      )}
      <div className="relative z-[1] w-full bg-gradient-to-t from-black/70 to-transparent p-4">
        <h1 className="text-2xl font-bold text-white sm:text-3xl">{title}</h1>
      </div>
    </div>
  );
}
