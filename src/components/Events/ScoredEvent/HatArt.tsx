import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

/** A hat centred on a glow of its team's colour, in a square. */
export function HatArt({
  url,
  color,
  className,
  width = 256,
}: {
  url: string;
  color?: string;
  className?: string;
  /** Source width in px; about twice the displayed size. */
  width?: number;
}) {
  return (
    <div
      className={clsx(
        'grid aspect-square w-full place-items-center rounded-md bg-gray-1 dark:bg-dark-7',
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
        className="w-3/5 drop-shadow-[0_6px_10px_rgba(0,0,0,0.35)]"
        loading="lazy"
        alt=""
      />
    </div>
  );
}
