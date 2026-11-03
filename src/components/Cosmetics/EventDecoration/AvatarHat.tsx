import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getAvatarHatLayout } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

export type AvatarShowcaseHat = { url: string; fit?: EventDecorationFit; until: string };

/** Whether a showcase hat from the server is still on show: a cached copy may outlive the event. */
export const isShowcaseHatShowing = (
  hat: AvatarShowcaseHat | null | undefined,
  now = Date.now()
): hat is AvatarShowcaseHat => !!hat?.url && new Date(hat.until).getTime() > now;

/** How far a showcase hat reaches above an avatar `size` px across, for a container that clips there. */
export const avatarHatOverhang = (hat: AvatarShowcaseHat, size: number) =>
  Math.ceil(getAvatarHatLayout(hat.fit, size).overhangTop);

/** A showcase hat on a round avatar `size` px across. Draws over the avatar and its frame. */
export function AvatarHat({ hat, size }: { hat: AvatarShowcaseHat; size: number }) {
  const layout = getAvatarHatLayout(hat.fit, size);
  return (
    <EdgeMedia
      src={hat.url}
      type="image"
      name="showcase hat"
      alt=""
      width={Math.round(layout.width * 2)}
      original={false}
      optimized
      data-showcase-hat=""
      className="pointer-events-none absolute max-w-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.45)]"
      style={{
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        transform: `rotate(${layout.tilt}deg)`,
        transformOrigin: layout.origin,
        zIndex: 2,
      }}
    />
  );
}
