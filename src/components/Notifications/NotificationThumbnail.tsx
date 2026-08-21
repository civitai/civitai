import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { NotificationThumbnailImage } from '~/components/Notifications/notification-thumbnails';

/**
 * Hidden preferences decide whether the viewer may see this image at all, and
 * have already run by the time it gets here. This decides the other question:
 * whether they asked to see it uncovered.
 *
 * The two are not the same set. With blur on, the mask covers every mature
 * level, including the ones inside the viewer's own browsing level — so an
 * image that legitimately passed the filter would otherwise render plainly, in
 * a dropdown over whatever page they are on, where the rest of the app blurs it.
 *
 * `explain={false}`: the Show overlay is a button and a badge, which do not fit
 * 48px, and its badge would name the rating of an image the viewer chose to
 * keep covered. Clicking through is the reveal path — the row already opens the
 * image, and the image page carries its own blur toggle.
 */
export function NotificationThumbnail({ image }: { image: NotificationThumbnailImage }) {
  return (
    <div className="relative size-12 shrink-0 overflow-hidden rounded-md">
      <ImageGuard2 image={image} explain={false}>
        {(safe) =>
          safe ? (
            <EdgeMedia
              src={image.url}
              type={image.type}
              width={90}
              alt=""
              anim={false}
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
