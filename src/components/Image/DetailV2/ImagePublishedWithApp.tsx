import { PostPublishedWithApp } from '~/components/Post/Detail/PostPublishedWithApp';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { resolveClientStoreScope } from '~/shared/utils/app-blocks-access';
import { scopeAdmitsListingKind } from '~/shared/utils/store-visibility-scope';
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
 * 🔴 The wrapper adds no horizontal padding and no margin: the card must be exactly as wide as
 * the cards beside it, and the sidebar column's `gap-3` spaces them
 * (`ImagePublishedWithApp.geometry.test.tsx` measures it).
 *
 * The query is sent only to viewers whose store scope admits on-site listings. The server
 * answers `null` before any read for everyone else (`resolveAppChip` gates on
 * `scopeAdmitsListingKind(storeScope, 'onsite')`), so for them the request could only ever
 * render nothing. The client scope comes from `resolveClientStoreScope`, which reads the same
 * Flipt keys the server's `resolveStoreVisibilityScope` evaluates (same entity id and context
 * for a signed-in viewer), and the same `scopeAdmitsListingKind` rule decides. Where they can
 * differ when Flipt answers nothing, the client is the wider side (an absent flag or a Flipt
 * outage falls back to `availability: ['mod']` here and to `false` on the server), so that
 * case costs a request the server answers `null`, never a hidden credit.
 */
export function ImagePublishedWithApp({ imageId }: { imageId: number }) {
  const canSeeOnsiteApps = scopeAdmitsListingKind(
    resolveClientStoreScope(useOptionalFeatureFlags()),
    'onsite'
  );
  const { data } = trpc.image.getPublishedWithApp.useQuery(
    { id: imageId },
    { enabled: canSeeOnsiteApps }
  );
  if (!data) return null;
  return (
    <div data-testid="image-published-with-app">
      <PostPublishedWithApp app={data} />
    </div>
  );
}
