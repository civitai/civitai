import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import { DRAFT_STICKER_Z } from '~/components/Sticker/placement-layers';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { keyIndexAt } from '~/shared/utils/sticker-track-edit';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';

const GHOST_OPACITY = 0.25;

/**
 * The selected sticker's path, key dots (filled to key opacity) and faint ghosts, drawn on the media.
 * Positions are fractions of the media box, as the keys are. The path's viewBox is stretched to the
 * box, so `non-scaling-stroke` is what keeps its line and dashes even.
 */
export function StickerMotionGuides({
  draft,
  art,
  playheadMs,
}: {
  draft: StickerDraft;
  art: ResolvedSticker;
  playheadMs: number;
}) {
  const keys = draft.motion?.keys ?? [];
  if (!draft.motion?.on || !keys.length) return null;
  const at = keyIndexAt(keys, playheadMs);
  const artworkStyle = stickerArtworkStyle({ flip: draft.flip, opacity: GHOST_OPACITY });

  return (
    <div
      aria-hidden
      data-motion-guides
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: DRAFT_STICKER_Z - 1 }}
    >
      {keys.map((key, index) =>
        index === at ? null : (
          <div
            key={key.t}
            data-motion-ghost={index}
            className="absolute"
            style={{
              left: `${key.x * 100}%`,
              top: `${key.y * 100}%`,
              width: `${key.s * 100}%`,
              transform: `translate(-50%, -50%) rotate(${key.r}deg)`,
            }}
          >
            <EdgeImage
              src={art.url}
              alt=""
              options={{ width: 512, anim: art.animated, optimized: true }}
              style={{ width: '100%', height: 'auto', display: 'block', ...artworkStyle }}
              draggable={false}
            />
          </div>
        )
      )}
      {keys.length > 1 && (
        <svg
          className="absolute inset-0 size-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <polyline
            data-motion-path
            points={keys.map((key) => `${key.x * 100},${key.y * 100}`).join(' ')}
            fill="none"
            stroke="white"
            strokeOpacity={0.6}
            strokeWidth={2}
            strokeDasharray="4 5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {keys.map((key, index) => (
        <span
          key={key.t}
          data-motion-key={index}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-solid border-yellow-5"
          style={{
            left: `${key.x * 100}%`,
            top: `${key.y * 100}%`,
            width: index === at ? 12 : 8,
            height: index === at ? 12 : 8,
            background: `rgba(252, 196, 25, ${key.o})`,
          }}
        />
      ))}
    </div>
  );
}
