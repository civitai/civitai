import clsx from 'clsx';
import { getHatPreviewBox } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

const pct = (share: number) => `${share * 100}%`;

/**
 * A hat centred on a glow of its team's colour, in a square. Given the hat's fit, the hat is sized
 * by its visible art, so hats of different shapes look alike in size; without one, by its canvas.
 */
export function HatArt({
  url,
  color,
  className,
  width = 256,
  fit,
}: {
  url: string;
  color?: string;
  className?: string;
  /** Source width in px; about twice the displayed size. */
  width?: number;
  fit?: EventDecorationFit;
}) {
  const box = getHatPreviewBox(fit);
  return (
    <div
      className={clsx(
        'relative grid aspect-square w-full place-items-center rounded-md bg-gray-1 dark:bg-dark-7',
        className
      )}
      style={
        color
          ? {
              backgroundImage: `radial-gradient(circle at 50% 60%, color-mix(in srgb, ${color} 40%, transparent), transparent 62%)`,
            }
          : undefined
      }
    >
      <EdgeMedia
        src={url}
        width={width}
        className={clsx(
          'drop-shadow-[0_6px_10px_rgba(0,0,0,0.35)]',
          box ? 'absolute max-w-none' : 'w-3/5'
        )}
        style={
          box
            ? {
                width: pct(box.width),
                height: pct(box.height),
                left: pct(box.left),
                top: pct(box.top),
              }
            : undefined
        }
        loading="lazy"
        alt=""
      />
    </div>
  );
}
