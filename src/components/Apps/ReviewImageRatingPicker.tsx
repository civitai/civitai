import { NativeSelect, Stack, Text } from '@mantine/core';
import { assetsWithImageLevel, previewWithImageLevel } from '~/components/Apps/reviewImageLevels';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NsfwLevel as NsfwLevelEnum, type NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

/**
 * A moderator's rating picker for ONE listing image on the review page, through the existing
 * `image.updateImageNsfwLevel`.
 *
 * 🔴 The server decides who is a moderator; hiding the picker from everyone else is
 * presentation, not the gate.
 *
 * A success patches the cached reads instead of refetching them, which could read the old level
 * back from a lagging replica (`reviewImageLevels.ts`).
 */
export function ReviewImageRatingPicker({
  imageId,
  nsfwLevel,
  label,
  listingIds,
  testId,
}: {
  imageId: number;
  /** The image's current level; a level that is not one of the five reads as "not rated". */
  nsfwLevel: number | null | undefined;
  /** What the image is, for the control's accessible name ("Icon", "Screenshot 2", …). */
  label: string;
  /** The listings whose cached reads show this image: the media card's, and the approve's. */
  listingIds: readonly string[];
  testId: string;
}) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const rerate = trpc.image.updateImageNsfwLevel.useMutation({
    onSuccess: async (_result, { id, nsfwLevel: level }) => {
      for (const listingId of listingIds) {
        utils.appListings.getAssets.setData({ listingId }, (view) =>
          assetsWithImageLevel(view, id, level)
        );
        utils.appListings.getListingPreviewForReview.setData({ listingId }, (preview) =>
          previewWithImageLevel(preview, id, level)
        );
      }
      await Promise.all([
        utils.appListings.getAssets.invalidate(undefined, { refetchType: 'none' }),
        utils.appListings.getListingPreviewForReview.invalidate(undefined, { refetchType: 'none' }),
      ]);
    },
  });
  if (!currentUser?.isModerator) return null;

  const current = browsingLevels.find((level) => level === nsfwLevel);
  return (
    <Stack gap={2}>
      <NativeSelect
        size="xs"
        aria-label={`${label} rating`}
        data-testid={testId}
        value={current === undefined ? '' : String(current)}
        disabled={rerate.isPending}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          const level = browsingLevels.find((l) => l === next);
          if (level === undefined || level === current) return;
          rerate.mutate({ id: imageId, nsfwLevel: level as NsfwLevel });
        }}
        data={[
          ...(current === undefined
            ? [
                {
                  value: '',
                  label: nsfwLevel === NsfwLevelEnum.Blocked ? 'Blocked' : 'Not rated',
                  disabled: true,
                },
              ]
            : []),
          ...browsingLevels.map((level) => ({
            value: String(level),
            label: `Rate ${browsingLevelLabels[level]}`,
          })),
        ]}
      />
      {rerate.isError && (
        <Text size="xs" c="red" maw={160} data-testid={`${testId}-error`}>
          {rerate.error.message}
        </Text>
      )}
    </Stack>
  );
}
