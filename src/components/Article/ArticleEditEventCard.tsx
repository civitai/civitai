import { Button, Group, Text } from '@mantine/core';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import { openEventHatPicker } from '~/components/Decorations/AddEventDecorationMenuItem';
import { EventEditorCard, EventHatButton } from '~/components/Events/EventEditorCard';
import { editorHatState } from '~/components/Events/event-editor-card.utils';
import { hatButtonLabel } from '~/components/Events/event-promos';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Props = {
  articleId: number;
  /** Only the picker's preview: the hat goes on the article, never on this image. */
  coverImage?: CardDecorationModalProps['image'];
  showDraftNote: boolean;
};

/** The playable event's card in the article editor: put a hat on this article, swap it or take it off. */
export function ArticleEditEventCard({ articleId, coverImage, showDraftNote }: Props) {
  return (
    <EventEditorCard
      surface="articleEditor"
      showDraftNote={showDraftNote}
      data-testid="article-edit-event-card"
    >
      {(event) => <ArticleHatActions event={event} articleId={articleId} coverImage={coverImage} />}
    </EventEditorCard>
  );
}

function ArticleHatActions({
  event,
  articleId,
  coverImage,
}: Omit<Props, 'showDraftNote'> & { event: string }) {
  const hatLabel = hatButtonLabel(event, CosmeticEntity.Article);
  const utils = trpc.useUtils();
  const teamColor = useTeamColor();
  const { data: hats, isLoading } = trpc.event.getMyHats.useQuery(
    { event },
    { enabled: !!hatLabel }
  );
  const { unequip, isLoading: removing } = useEquipContentDecoration();
  if (!hatLabel || isLoading || !hats) return null;
  if (!coverImage)
    return (
      <Text size="xs" c="gray.4">
        Add a cover image to put on a hat.
      </Text>
    );

  const openPicker = () =>
    openEventHatPicker({
      props: { entityType: CosmeticEntity.Article, entityId: articleId, image: coverImage, event },
    });
  const state = editorHatState(hats, { entityType: CosmeticEntity.Article, entityId: articleId });

  if (state.kind === 'join')
    return <EventHatButton onClick={openPicker}>Join a team</EventHatButton>;
  if (state.kind === 'add') return <EventHatButton onClick={openPicker}>{hatLabel}</EventHatButton>;

  const { hat } = state;
  const data = hat.data as EventDecorationData;
  const takeOff = async () => {
    try {
      await unequip({
        equippedToType: CosmeticEntity.Article,
        equippedToId: articleId,
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
            On this article · {numberWithCommas(hat.points)} pts
          </Text>
        </div>
      </div>
      <Group grow gap="xs">
        <Button size="compact-sm" variant="default" onClick={openPicker}>
          Swap hat
        </Button>
        <Button size="compact-sm" variant="default" loading={removing} onClick={takeOff}>
          Take off
        </Button>
      </Group>
    </>
  );
}
