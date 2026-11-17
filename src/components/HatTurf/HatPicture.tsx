import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import { isEventDecorationData } from '~/shared/constants/event-decoration.constants';

/** The hat's art on its team's glow; the plain cone while the art is unknown. */
export function HatPicture({ data, color, size }: { data: unknown; color: string; size: number }) {
  return (
    <span
      className="grid flex-none place-items-center overflow-hidden rounded-md bg-gray-1 dark:bg-dark-7"
      style={{ width: size, height: size }}
    >
      {isEventDecorationData(data) && data.url ? (
        <HatArt url={data.url} fit={data.fit} color={color} width={size * 2} />
      ) : (
        <TeamHat color={color} size={Math.round(size * 0.6)} />
      )}
    </span>
  );
}
