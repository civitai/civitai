import type { WornDecoration } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { EventDecorationOverlay } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';

/**
 * The article's own hat, in its cover's top-left corner on the article page. Drawn `inside`
 * because the cover's aspect-ratio box clips what hangs past its edge. The cover image cannot
 * wear an image hat of its own, so this is the article's.
 */
export function ArticleCoverHat({
  articleId,
  decoration,
}: {
  articleId: number;
  decoration: WornDecoration;
}) {
  if (!decoration) return null;
  return (
    <EventDecorationOverlay
      decoration={decoration.data}
      placement="inside"
      wornOn={{ entityType: 'Article', entityId: articleId }}
    />
  );
}
