import { Anchor } from '@mantine/core';
import { openEventHatPicker } from '~/components/Decorations/AddEventDecorationMenuItem';
import { EditorHatActions } from '~/components/Events/EditorHatActions';
import { EventEditorCard, EventHatButton } from '~/components/Events/EventEditorCard';
import { hatButtonLabel } from '~/components/Events/event-promos';
import { useEventPromos } from '~/components/Events/useEventPromos';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';

/**
 * The playable event's card under Publish: a way to hat this post's cover image without leaving
 * the editor. For a post that belongs to a model it hats the model, when the event has copy for
 * that, with the cover image a step aside.
 */
export function PostEditEventCard({
  coverImage,
  showDraftNote,
  modelId,
}: {
  coverImage?: CardDecorationModalProps['image'];
  showDraftNote: boolean;
  modelId?: number;
}) {
  const promos = useEventPromos();
  const hatCover = (event: string) =>
    coverImage &&
    (() =>
      openEventHatPicker({
        props: {
          entityType: CosmeticEntity.Image,
          entityId: coverImage.id,
          image: coverImage,
          event,
        },
      }));

  if (modelId && promos.some((promo) => promo.modelEditor))
    return (
      <EventEditorCard
        surface="modelEditor"
        showDraftNote={showDraftNote}
        data-testid="model-post-edit-event-card"
      >
        {(event) => {
          const onCover = hatButtonLabel(event) && hatCover(event);
          return (
            <>
              <EditorHatActions
                event={event}
                entityType={CosmeticEntity.Model}
                entityId={modelId}
                coverImage={coverImage}
              />
              {onCover && (
                <Anchor component="button" size="xs" c="blue.3" onClick={onCover}>
                  or hat the cover image instead
                </Anchor>
              )}
            </>
          );
        }}
      </EventEditorCard>
    );

  return (
    <EventEditorCard
      surface="postEditor"
      showDraftNote={showDraftNote}
      data-testid="post-edit-event-card"
    >
      {(event) => {
        const hatLabel = hatButtonLabel(event);
        const onCover = hatCover(event);
        return hatLabel && onCover && <EventHatButton onClick={onCover}>{hatLabel}</EventHatButton>;
      }}
    </EventEditorCard>
  );
}
