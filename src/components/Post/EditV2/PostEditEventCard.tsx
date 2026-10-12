import { openEventHatPicker } from '~/components/Decorations/AddEventDecorationMenuItem';
import { EventEditorCard, EventHatButton } from '~/components/Events/EventEditorCard';
import { hatButtonLabel } from '~/components/Events/event-promos';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';

/**
 * The playable event's card under Publish: a way to hat this post's cover image without leaving
 * the editor.
 */
export function PostEditEventCard({
  coverImage,
  showDraftNote,
}: {
  coverImage?: CardDecorationModalProps['image'];
  showDraftNote: boolean;
}) {
  return (
    <EventEditorCard
      surface="postEditor"
      showDraftNote={showDraftNote}
      data-testid="post-edit-event-card"
    >
      {(event) => {
        const hatLabel = hatButtonLabel(event);
        return (
          hatLabel &&
          coverImage && (
            <EventHatButton
              onClick={() =>
                openEventHatPicker({
                  props: {
                    entityType: CosmeticEntity.Image,
                    entityId: coverImage.id,
                    image: coverImage,
                    event,
                  },
                })
              }
            >
              {hatLabel}
            </EventHatButton>
          )
        );
      }}
    </EventEditorCard>
  );
}
