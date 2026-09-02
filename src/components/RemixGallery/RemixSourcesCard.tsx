import { CustomCard } from '~/components/Post/EditV2/PostImageCards/CustomCard';
import { RemixSourcesList, useRemixSources } from '~/components/RemixGallery/RemixSourcesList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * The galleries this image could be submitted to, in the post editor's image
 * card, directly under the image.
 *
 * Renders nothing when the image has no remix provenance, which is the ordinary
 * case: 0.2% of on-site generations carried any (measured 2026-08-27). A card
 * that always drew a header would sit empty on almost every post.
 */
export function RemixSourcesCard({
  imageId,
  /** Only changes what the success message promises; both states submit here. */
  published,
}: {
  imageId: number;
  published: boolean;
}) {
  const features = useFeatureFlags();
  const { sources, isLoading } = useRemixSources(imageId, !!features.remixGalleryPostEditor);

  if (isLoading) return null;
  if (!sources?.length) return null;

  return (
    <CustomCard className="flex flex-col gap-2">
      <h3 className="text-lg font-semibold leading-none text-dark-7 dark:text-gray-0">
        Submit this remix
      </h3>
      <RemixSourcesList imageId={imageId} published={published} />
    </CustomCard>
  );
}
