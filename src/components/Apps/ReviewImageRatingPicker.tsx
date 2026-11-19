import { NativeSelect, Stack, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

/**
 * A moderator's rating picker for ONE listing image on the review page.
 *
 * 🔴 NO NEW WRITE PATH. It calls the existing `image.updateImageNsfwLevel`, whose MODERATOR
 * branch is what makes the choice the image's real rating everywhere: it sets the level, locks
 * it against the automated rater (`nsfwLevelLocked`), settles pending votes, and re-derives the
 * rating of every store listing that shows the image. The server decides who is a moderator;
 * hiding the picker from everyone else is presentation, not the gate.
 *
 * After a success the two reads that show this image's level are re-read:
 * `appListings.getAssets` (the media badges here, and the approve bar's "approving raises the
 * rating" warning, `OnsiteApproveRatingWarning`) and `appListings.getListingPreviewForReview`
 * (the screenshots row). A refusal is shown under the picker, as the server worded it.
 */
export function ReviewImageRatingPicker({
  imageId,
  nsfwLevel,
  label,
  testId,
}: {
  imageId: number;
  /** The image's current level; a level that is not one of the five reads as "not rated". */
  nsfwLevel: number | null | undefined;
  /** What the image is, for the control's accessible name ("Icon", "Screenshot 2", …). */
  label: string;
  testId: string;
}) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const rerate = trpc.image.updateImageNsfwLevel.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.appListings.getAssets.invalidate(),
        utils.appListings.getListingPreviewForReview.invalidate(),
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
          ...(current === undefined ? [{ value: '', label: 'Not rated', disabled: true }] : []),
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
