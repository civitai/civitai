import { Button, Group, Text } from '@mantine/core';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import { openEventHatPicker } from '~/components/Decorations/AddEventDecorationMenuItem';
import { EventHatButton } from '~/components/Events/EventEditorCard';
import { editorHatState } from '~/components/Events/event-editor-card.utils';
import { hatButtonLabel } from '~/components/Events/event-promos';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const NOUN = { Article: 'article', Model: 'model' } as const;

/**
 * What an editor's event card offers for its content, from the viewer's own hats: join a team, put
 * a hat on, or the hat it wears with swap and take off.
 */
export function EditorHatActions({
  event,
  entityType,
  entityId,
  coverImage,
}: {
  event: string;
  entityType: Extract<CosmeticEntity, 'Article' | 'Model'>;
  entityId: number;
  /** Only the picker's preview: the hat goes on the content, never on this image. */
  coverImage?: CardDecorationModalProps['image'];
}) {
  const hatLabel = hatButtonLabel(event, entityType);
  const utils = trpc.useUtils();
  const teamColor = useTeamColor();
  const { data: hats, isLoading } = trpc.event.getMyHats.useQuery(
    { event },
    { enabled: !!hatLabel }
  );
  const { unequip, isLoading: removing } = useEquipContentDecoration();
  if (!hatLabel || isLoading || !hats) return null;

  const state = editorHatState(hats, { entityType, entityId });
  // The picker previews the hat on the cover, so it needs one; taking a hat off does not.
  const openPicker =
    coverImage &&
    (() =>
      openEventHatPicker({
        props: { entityType, entityId, image: coverImage, event },
      }));

  if (state.kind !== 'worn') {
    if (!openPicker)
      return (
        <Text size="xs" c="gray.4">
          Add a cover image to put on a hat.
        </Text>
      );
    return (
      <EventHatButton onClick={openPicker}>
        {state.kind === 'join' ? 'Join a team' : hatLabel}
      </EventHatButton>
    );
  }

  const { hat } = state;
  const data = hat.data as EventDecorationData;
  const takeOff = async () => {
    try {
      await unequip({
        equippedToType: entityType,
        equippedToId: entityId,
        cosmeticId: hat.cosmeticId,
      });
      await utils.event.getMyHats.invalidate({ event });
    } catch {
      // The equip hook shows the error.
    }
  };
  return (
    <>
      <div className="flex items-center gap-2 rounded-md bg-white/5 p-2" data-testid="worn-hat">
        <HatArt
          url={data.url}
          color={data.team ? teamColor(data.team) : undefined}
          width={96}
          className="!w-10 flex-none !bg-transparent"
        />
        <div className="min-w-0">
          <Text size="sm" fw={700} lineClamp={1}>
            {hat.name}
          </Text>
          <Text size="xs" c="gray.4">
            On this {NOUN[entityType]} · {numberWithCommas(hat.points)} pts
          </Text>
        </div>
      </div>
      <Group grow gap="xs">
        {openPicker && (
          <Button size="compact-sm" variant="default" onClick={openPicker}>
            Swap hat
          </Button>
        )}
        <Button size="compact-sm" variant="default" loading={removing} onClick={takeOff}>
          Take off
        </Button>
      </Group>
    </>
  );
}
