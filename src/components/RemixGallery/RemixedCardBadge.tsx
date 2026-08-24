import { IconHierarchy } from '@tabler/icons-react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import {
  demoRemixCount,
  useFinePointer,
  useRemixDemoDensity,
  useRemixPeelStore,
} from '~/components/RemixGallery/remix-card-demo';

/**
 * The "remixed" counterpart to the Remix button on a media card.
 *
 * Deliberately the same object as the button it sits under: `HoverActionButton`
 * at the same size, colour and variant, so the pair reads as one control for
 * making a remix and one for seeing the remixes that exist. A bespoke pill in
 * this corner would be a third visual language on a card that already carries a
 * context menu, a blur toggle, a duration badge and a reactions row.
 *
 * `keepIconOnHover` is the one departure. The Remix button swaps to an arrow on
 * hover because it goes somewhere; this opens something in place, so the icon
 * has to stay or the badge claims a navigation it does not perform.
 *
 * Only rendered when entries exist. That is the whole point of the treatment —
 * every image can already be remixed via the button above, so a badge on an
 * image with nothing in its gallery would be a second, weaker way to say what
 * the Remix button already says.
 */
export function RemixedCardBadge({ imageId }: { imageId: number }) {
  const toggle = useRemixPeelStore((state) => state.toggle);
  const count = demoRemixCount(imageId, useRemixDemoDensity());
  const fine = useFinePointer();
  if (!count || !fine) return null;

  return (
    <HoverActionButton
      label={count === 1 ? '1 remix' : `${count} remixes`}
      size={30}
      color="white"
      variant="filled"
      keepIconOnHover
      aria-label={`Show the ${count} ${count === 1 ? 'remix' : 'remixes'} of this image`}
      onClick={(event) => {
        // The whole card is a link and this sits on top of it.
        event.preventDefault();
        event.stopPropagation();
        toggle(imageId);
      }}
    >
      <IconHierarchy stroke={2.5} size={16} />
    </HoverActionButton>
  );
}
