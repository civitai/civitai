import { PostPublishedWithApp } from '~/components/Post/Detail/PostPublishedWithApp';
import { trpc } from '~/utils/trpc';

/**
 * The image detail page's "Published with <app>" credit.
 *
 * Only the DATA is image-specific: the server resolves the image's own App Block
 * marker (`image.getPublishedWithApp` → `readImageAppChip`) through the same
 * resolver as the post page, and the RENDERING is the post page's component
 * unchanged — so the wording ("Published WITH", never "by"), the three states
 * (null → nothing, `slug: null` → unlinked name, `slug` → store link) and the
 * icon handling are defined once, in `PostPublishedWithApp`. Read its header
 * before changing anything here.
 *
 * Its own query, rather than a field on the image payload, because the sidebar
 * renders whichever payload brought the image there (a feed page, a post's image
 * list or `image.get`); see `getImagePublishedWithAppHandler`.
 *
 * Renders nothing while loading, on error, and for the overwhelmingly common
 * `null` — the credit is decoration and must never shift or break the sidebar.
 * 🔴 NO horizontal padding here, and no negative margin: the credit is a card now, and a card
 * is exactly as wide as the cards beside it (the sidebar column's `gap-3` spaces them).
 * `ImagePublishedWithApp.geometry.test.tsx` measures it; the old `px-4` indent, from when
 * this was a one-line text credit, made it 32px narrower than its neighbours.
 */
export function ImagePublishedWithApp({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getPublishedWithApp.useQuery({ id: imageId });
  if (!data) return null;
  return (
    <div data-testid="image-published-with-app">
      <PostPublishedWithApp app={data} />
    </div>
  );
}
