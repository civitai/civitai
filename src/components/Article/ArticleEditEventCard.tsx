import { EditorHatActions } from '~/components/Events/EditorHatActions';
import { EventEditorCard } from '~/components/Events/EventEditorCard';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';

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
      {(event) => (
        <EditorHatActions
          event={event}
          entityType={CosmeticEntity.Article}
          entityId={articleId}
          coverImage={coverImage}
        />
      )}
    </EventEditorCard>
  );
}
