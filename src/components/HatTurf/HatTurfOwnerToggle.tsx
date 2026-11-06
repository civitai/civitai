import { Switch } from '@mantine/core';
import { HAT_TURF_SETTING_LABEL } from '~/components/Account/HatTurfSetting';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getReleasedEventDecoration } from '~/shared/constants/event-decoration.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const HAT_TURF_OWNER_LABEL = 'Let people play Hat Turf on my images';

/**
 * An owner's way to keep Hat Turf off their images, for every signed-in user while turf runs (no
 * feature flag: it answers people who are not playing). Off hides and uncounts the hats already
 * there until it is back on. A player cannot turn it off; the server refuses that too.
 */
export function useHatTurfOwnerSwitch() {
  const user = useCurrentUser();
  const event = getReleasedEventDecoration('Image')?.event;
  const utils = trpc.useUtils();
  const { data: stock } = trpc.hatTurf.getStock.useQuery(
    { event: event ?? '' },
    { enabled: !!user && !!event, staleTime: 30_000, retry: false }
  );
  const setOwnerOff = trpc.hatTurf.setOwnerOff.useMutation({
    onSuccess: () => {
      void utils.hatTurf.getStock.invalidate();
      void utils.hatTurf.getSummaries.invalidate();
      void utils.hatTurf.getStickersForImages.invalidate();
      void utils.hatTurf.getImageStickers.invalidate();
    },
    onError: (error) => showErrorNotification({ title: "Couldn't update Hat Turf", error }),
  });
  if (!user || !event || !stock || stock.mode === 'off') return null;

  return {
    description: stock.optedIn ? (
      // The switch that leaves is in the Profile pane, not this Creator one.
      <>
        Turn off{' '}
        <NextLink href="/user/account/profile#hat-turf" className="underline">
          &ldquo;{HAT_TURF_SETTING_LABEL}&rdquo;
        </NextLink>{' '}
        first
      </>
    ) : (
      "Off hides team hats on your images and they stop counting. They're back if you turn it on."
    ),
    switchProps: {
      name: 'hatTurfOwner',
      checked: !stock.ownerOff,
      disabled: stock.optedIn || setOwnerOff.isPending,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setOwnerOff.mutate({ event, off: !e.currentTarget.checked }),
      'data-testid': 'hat-turf-owner-toggle',
    },
  };
}

export function HatTurfOwnerToggle() {
  const owner = useHatTurfOwnerSwitch();
  if (!owner) return null;
  return (
    <Switch
      label={HAT_TURF_OWNER_LABEL}
      description={owner.description}
      styles={{ track: { flex: '0 0 1em' } }}
      {...owner.switchProps}
    />
  );
}
