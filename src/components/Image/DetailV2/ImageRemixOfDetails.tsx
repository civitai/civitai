import { Card, Text } from '@mantine/core';
import { IconArrowBackUp } from '@tabler/icons-react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { trpc } from '~/utils/trpc';

/**
 * The source image's own shape. Square is a CEILING ON HEIGHT, not the shape.
 *
 * Justin's call, 2026-08-27, arrived at over two wrong attempts, both of which
 * are worth knowing about because both looked finished:
 *
 *  1. `aspectRatio="square"` cropped every source to a square.
 *  2. Clamping the RATIO with `Math.max(ratio, 1)` silently re-squared every
 *     PORTRAIT source, which is most of them — the demo source is 928x1152,
 *     ratio 0.806, and it rendered as a perfect square with no error anywhere.
 *     A clamp that fires on the common case is not a guard.
 *
 * So the cap belongs on the box, not on the number. The tile is a square frame
 * and the image keeps its true ratio inside it: a wide source is width-bound and
 * renders short, a tall source is height-bound and renders narrow. Neither is
 * cropped, and neither can push the Remix Gallery below the fold.
 */
function sourceAspectRatio(image: { width?: number | null; height?: number | null }) {
  // Fall back to square rather than to 0 — `aspectRatio: 0` collapses the tile to
  // nothing, which reads as the card being broken rather than as one image
  // lacking dimensions.
  if (!image.width || !image.height) return 1;
  return image.width / image.height;
}

/**
 * "This is a remix of X" — the source image(s) this one was derived from.
 *
 * Reads `remixOfIds`, which is server-VERIFIED provenance only
 * (`meta.extra.sourceImageIds`). The older client-declared `meta.extra.remixOfId`
 * is deliberately excluded — Justin's ruling, 2026-08-27 — which knowingly costs
 * about half of all remixes their card. See `getRemixSourceIds` in
 * image.service.ts before "fixing" that.
 *
 * So absent on almost every image, by design twice over: 101 of 51,661 on-site
 * generations in a 24h prod sample carried any provenance at all. A blank
 * sidebar here is the ordinary answer, not a broken query.
 *
 * 🔴 `image.get` per id, NOT `useQueryImages({ ids })`, and that is not a style
 * preference. `ids` is absent from `requiresImageDbPath`, so an ids-only feed
 * query routes to the search index — where `ids` is commented out of the
 * destructure and silently ignored. Measured against this dev server on
 * 2026-08-27: asking for `ids: [140383933]` returned image `12097475`. Not an
 * error and not an empty list — a real image from the global feed, wearing the
 * caption "remixed from". Anyone moving this back to the feed helper must first
 * assert on the returned IDS, never on the count.
 *
 * What actually gates a source tile, stated precisely because an earlier version
 * of this comment overclaimed it twice:
 *
 * - `image.get` server-side: unpublished or private post, `nsfwLevel = Blocked`,
 *   `needsReview`, `imageReviewedSql()`. `getImageHandler` adds `amIBlockedByUser`.
 * - `useApplyHiddenPreferences`: hidden users, hidden images, POI and minor.
 * - ⚠️ NOT hidden tags. That filter reads `image.tagIds`, and `getImage` selects
 *   no tag data, so `image.tagIds ?? []` is empty and both the viewer's
 *   `hiddenTags` and the platform's `excludedTagIds` loops are no-ops here. The
 *   feed path fetches tag ids from cache for exactly this reason
 *   (image.service.ts, "Fetch tagIds from cache so client-side hidden-tag
 *   filtering works"). Known and accepted — Justin, 2026-08-27 — rather than
 *   overlooked. Closing it means giving `getImage` an opt-in tag fetch.
 * - ⚠️ The browsing level here is NOT the viewer's saved preference.
 *   `ImageDetail2` wraps this sidebar in
 *   `<BrowsingLevelProvider browsingLevel={image.nsfwLevel}>`, so the strict
 *   `Flags.intersects` test below compares the source against the REMIX's level.
 *   The domain cap still wins (`forcedBrowsingLevel` takes priority) and
 *   `ImageGuard2` still blurs from the viewer's own level, and `RemixGalleryCard`
 *   beside this reads the same overridden value — so this is the established
 *   detail-page pattern, not something this card invents. Do not describe it as
 *   the viewer-specific gate; it is not one.
 */
export const ImageRemixOfDetails = ({ imageId }: { imageId: number }) => {
  const { data: generationData } = trpc.image.getGenerationData.useQuery({ id: imageId });
  const remixOfIds = generationData?.remixOfIds ?? [];

  // Bounded at 8 by `getRemixSourceIds`, which re-applies MAX_SOURCE_IMAGES on
  // the READ path. Do not move that bound: `sanitizeProvenance` writes what it is
  // given verbatim, so nothing about a stored row limits this list. An earlier
  // version of this comment claimed the writer capped it; it does not.
  //
  // In practice it is one query, not eight — measured on the prod replica
  // 2026-08-27, every image carrying the field over a 5-day window (309 rows) had
  // exactly one source, max and average both 1. And 0.1% of images carry it at
  // all, so 999 detail views in 1000 fan out to nothing.
  const queries = trpc.useQueries((t) => remixOfIds.map((id) => t.image.get({ id })));
  const sources = queries.map((query) => query.data).filter((data) => !!data);
  const isLoading = queries.some((query) => query.isLoading);

  // Deliberately WITHOUT `allowLowerLevels`, which the pre-2025 version of this
  // card passed. That option swaps the strict `Flags.intersects` test for
  // `nsfwLevel > maxBrowsingLevel`, so a level specifically switched OFF still
  // renders as long as something above it is on. Fine for a feed that was asked
  // for; wrong for an image pulled in sideways by somebody else's provenance,
  // which is what every tile here is. See the docblock for which level this
  // actually tests against — it is not the viewer's saved preference.
  const { items: images } = useApplyHiddenPreferences({ type: 'images', data: sources });

  if (!remixOfIds.length || isLoading || !images.length) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <Text className="flex items-center gap-2 text-xl font-semibold">
        <IconArrowBackUp />
        <span>{images.length > 1 ? 'Remixed from these' : 'Remixed from'}</span>
      </Text>

      <div className={images.length > 1 ? 'grid grid-cols-2 gap-3' : undefined}>
        {images.map((image) => {
          const ratio = sourceAspectRatio(image);
          // The square frame is the height ceiling; the tile fits inside it on
          // whichever axis binds first. `w-full` for wide, `h-full` for tall —
          // set on both the link and the card, because the link is the flex item
          // that has to stop filling the frame.
          const fit = ratio >= 1 ? 'w-full' : 'h-full';
          return (
            <div key={image.id} className="flex aspect-square items-center justify-center">
              <RoutedDialogLink name="imageDetail" state={{ imageId: image.id }} className={fit}>
                <AspectRatioImageCard
                  image={image}
                  aspectRatio={ratio}
                  className={fit}
                  header={<UserAvatarSimple {...image.user} />}
                />
              </RoutedDialogLink>
            </div>
          );
        })}
      </div>
    </Card>
  );
};
