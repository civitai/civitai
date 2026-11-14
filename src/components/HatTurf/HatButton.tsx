import { FlagHatButton } from '~/components/HatTurf/FlagRace/FlagHatButton';
import { useFlag } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { HatTurfButton } from '~/components/HatTurf/HatTurfButton';

/** A card's hat button: on one of today's flags in the home row it asks how many hats to stack. */
export function HatButton({ imageId }: { imageId: number }) {
  const flag = useFlag(imageId);
  return flag ? <FlagHatButton imageId={imageId} /> : <HatTurfButton imageId={imageId} />;
}
