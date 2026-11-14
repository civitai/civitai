import { useState } from 'react';
import { Button, Group, Text } from '@mantine/core';
import { Popover } from '~/components/MantineOverlays';
import { HatButtonFace } from '~/components/HatTurf/HatTurfButton';
import classes from '~/components/HatTurf/HatTurfButton.module.css';
import { useFlag } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { flagHatChoices } from '~/components/HatTurf/FlagRace/flag-race.utils';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { useChosenHat, useHatStock, useJoin } from '~/components/HatTurf/useHatTurf';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The hat button on a home-row flag: the same face as everywhere, but a press asks how many hats to
 * stack on the flag instead of placing one. Hidden once the flag has closed.
 */
export function FlagHatButton({ imageId }: { imageId: number }) {
  const found = useFlag(imageId);
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const stock = useHatStock();
  const { cosmeticId } = useChosenHat();
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const join = useJoin(() => setOpen(false));
  const place = trpc.hatTurf.placeFlagHats.useMutation({
    onSuccess: (standing) => {
      setOpen(false);
      // The shared summary is cached for everyone; show the placer their flag's fresh counts now.
      utils.hatTurf.getFlags.setData({ event: found?.event ?? '' }, (current) =>
        current
          ? {
              ...current,
              flags: current.flags.map((f) => (f.imageId === standing.imageId ? standing : f)),
            }
          : current
      );
      void utils.hatTurf.getStock.invalidate();
    },
    onError: (error) => showErrorNotification({ title: "Couldn't add hats", error }),
  });

  if (!found || !feed || !user || !stock || found.summary.closed) return null;
  const { event, rank } = found;
  const joined = stock.optedIn;
  const choices = flagHatChoices(stock.available ?? 0);

  return (
    <div className={classes.wrap} data-testid="flag-hat-button">
      <HatButtonFace
        joined={joined}
        empty={joined && !choices.length}
        active={open}
        placed={false}
        stock={stock}
        aria-label={joined ? `Add hats to flag ${rank}` : 'Join Hat Turf to add hats'}
        aria-expanded={open}
        className={classes.feed}
        onClick={(e) => {
          // The card is a link and this sits inside it.
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
      />
      <Popover
        opened={open}
        onChange={setOpen}
        withinPortal
        position="top-end"
        withArrow
        shadow="md"
      >
        <Popover.Target>
          <span className={classes.anchor} />
        </Popover.Target>
        <Popover.Dropdown p="sm" onClick={(e) => e.stopPropagation()}>
          {!joined ? (
            <>
              <Text size="sm" fw={600} maw={200}>
                Join Hat Turf to add hats to flags for your team.
              </Text>
              <Button
                mt="xs"
                size="xs"
                fullWidth
                color="yellow"
                loading={join.isPending}
                onClick={() => join.mutate({ event, optedIn: true })}
              >
                Join Hat Turf
              </Button>
            </>
          ) : !choices.length ? (
            <Text size="sm" maw={200} data-testid="flag-hat-none">
              You don&apos;t have any hats to add to this race right now.
            </Text>
          ) : (
            <>
              <Text size="sm" fw={600} mb={6} id={`flag-hats-q-${imageId}`}>
                How many hats would you like to place?
              </Text>
              <Group gap={6} wrap="nowrap" role="group" aria-labelledby={`flag-hats-q-${imageId}`}>
                {choices.map((count) => (
                  <Button
                    key={count}
                    size="xs"
                    miw={44}
                    disabled={!cosmeticId || place.isPending}
                    loading={place.isPending && place.variables?.count === count}
                    data-testid={`flag-add-${count}`}
                    onClick={() =>
                      cosmeticId && place.mutate({ event, imageId, cosmeticId, count })
                    }
                  >
                    {count}
                  </Button>
                ))}
              </Group>
            </>
          )}
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}
