import { Button, Modal, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconCheck, IconSparkles } from '@tabler/icons-react';
import clsx from 'clsx';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import { isShowcaseLive, SHOWCASE_EVENT } from '~/shared/constants/showcase-hat.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * "Pick your showcase hat", while the showcase event runs. For a player who joined: the caller
 * checks that. Opens the picker; the pick shows on their avatar on profiles, creator cards, comments
 * and the roster.
 */
export function ShowcaseHatButton({ event, color }: { event: string; color?: string }) {
  if (event !== SHOWCASE_EVENT.name || !isShowcaseLive()) return null;
  return (
    <Button
      variant="light"
      color={color}
      radius="xl"
      leftSection={<IconSparkles size={16} />}
      onClick={() => dialogStore.trigger({ component: ShowcaseHatModal, props: { event, color } })}
      data-testid="showcase-hat-button"
    >
      Pick your showcase hat
    </Button>
  );
}

function ShowcaseHatModal({ event, color }: { event: string; color?: string }) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const { data: hats } = trpc.event.getMyHats.useQuery({ event });
  const { data: current } = trpc.event.getMyShowcaseHat.useQuery({ event });
  const { mutate, isPending, variables } = trpc.event.setShowcaseHat.useMutation({
    onSuccess: async (result) => {
      utils.event.getMyShowcaseHat.setData({ event }, result);
      await Promise.all([
        utils.user.getCreator.invalidate(),
        utils.userProfile.get.invalidate(),
        utils.event.getTeamRoster.invalidate(),
      ]);
    },
    onError: (error) => showErrorNotification({ title: 'Could not save', error }),
  });

  // One tile per design: a player can hold the same hat twice.
  const designs = [
    ...new Map(
      (hats ?? []).flatMap((h) => {
        const data = h.data as EventDecorationData;
        return data?.url ? [[h.cosmeticId, { cosmeticId: h.cosmeticId, name: h.name, data }]] : [];
      })
    ).values(),
  ];
  const pending = isPending ? variables?.cosmeticId : undefined;
  const pick = current?.pick ?? null;

  return (
    <Modal {...dialog} title="Pick your showcase hat" size="lg" radius="md">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          It shows on your avatar on your profile, your creator card, your comments and the team
          roster until the event ends. It stays on your content too.
        </Text>
        <SimpleGrid cols={{ base: 3, xs: 4 }} spacing="sm">
          <Tile
            selected={pick === null}
            busy={pending === null}
            disabled={isPending || !current}
            onClick={() => mutate({ event, cosmeticId: null })}
            label="Automatic"
            testId="showcase-hat-auto"
          >
            <div className="grid aspect-square w-full place-items-center rounded-md border border-dashed border-gray-4 px-2 text-center dark:border-dark-3">
              <Text size="xs" c="dimmed">
                Your top hat
              </Text>
            </div>
          </Tile>
          {designs.map((hat) => (
            <Tile
              key={hat.cosmeticId}
              selected={pick === hat.cosmeticId}
              busy={pending === hat.cosmeticId}
              disabled={isPending || !current}
              onClick={() => mutate({ event, cosmeticId: hat.cosmeticId })}
              label={hat.name}
              testId="showcase-hat-option"
            >
              <HatArt url={hat.data.url} fit={hat.data.fit} color={color} width={192} />
            </Tile>
          ))}
        </SimpleGrid>
      </Stack>
    </Modal>
  );
}

function Tile({
  selected,
  busy,
  disabled,
  onClick,
  label,
  testId,
  children,
}: {
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={clsx(
        'relative flex flex-col gap-1 rounded-lg p-1 outline outline-2 transition-opacity',
        selected ? 'outline-blue-5' : 'outline-transparent',
        busy && 'opacity-60',
        disabled && !busy && 'cursor-default'
      )}
      data-testid={testId}
    >
      {children}
      {selected && (
        <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-blue-6 text-white">
          <IconCheck size={14} />
        </span>
      )}
      <Text size="xs" truncate ta="center" fw={selected ? 700 : 400}>
        {label}
      </Text>
    </UnstyledButton>
  );
}
