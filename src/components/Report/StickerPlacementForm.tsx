import { Alert, Group, Skeleton, Stack, Text } from '@mantine/core';
import { useEffect } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type * as z from 'zod';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useReportTarget } from '~/components/Report/report-target.context';
import { createReportForm } from '~/components/Report/create-report-form';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { InputTextArea } from '~/libs/form';
import { reportStickerPlacementDetailsSchema } from '~/server/schema/report.schema';
import { trpc } from '~/utils/trpc';

/**
 * Reporting a sticker someone placed on this image, or the note hanging off it.
 *
 * The form asks nothing about which one. It is only reached from a flag on the
 * sticker itself, so the placement and the half being reported both arrive with
 * the modal — the picker this replaced could not tell four copies of the same
 * sticker apart, and a moderator acted on the guess.
 */
type DetailsSchema = typeof reportStickerPlacementDetailsSchema;

function StickerPlacementFields({
  context,
}: {
  context: { form: UseFormReturn<z.input<DetailsSchema>, any, z.output<DetailsSchema>> };
}) {
  const target = useReportTarget();
  const placementId = target?.placementId;
  const half = target?.placementTarget ?? 'sticker';

  const { data, isLoading, isError } = trpc.placement.getStickerPlacementDetail.useQuery(
    { placementId: placementId as number },
    { enabled: !!placementId, staleTime: 5 * 60_000 }
  );
  const cosmeticId = data?.sticker?.id;
  const { sticker } = useStickerCosmetics(cosmeticId ? [cosmeticId] : []);
  const art = cosmeticId ? sticker.get(cosmeticId) : undefined;

  const { setValue } = context.form;

  // Written into the form rather than assembled beside it at submit, so the
  // value the report carries is the value the schema validated. Two sources of
  // truth for the one field that decides which sticker a moderator acts on is
  // how the wrong person loses a sticker and the Buzz under it.
  useEffect(() => {
    if (placementId) setValue('placementId', placementId);
    setValue('target', half);
  }, [placementId, half, setValue]);

  // Unreachable from the app: nothing opens this form without a placement. Said
  // out loud anyway, because the alternative is a Submit button that fails
  // validation on a field with nowhere to render the error and so does nothing.
  if (!placementId)
    return (
      <Alert color="yellow">
        <Text size="xs">
          Report a sticker from the flag on the sticker itself, so we know which one you mean.
        </Text>
      </Alert>
    );

  return (
    <Stack gap="xs">
      {isLoading ? (
        <Skeleton height={48} radius="sm" />
      ) : isError || !data ? (
        // Named or nothing. The line below is the reporter's only confirmation
        // that the right sticker was flagged, and rendering the generic version
        // of it over a failed lookup is the form claiming to have checked
        // something it could not. The report still sends: a sticker taken down
        // between the flag and the modal is exactly what someone might be
        // reporting, and the queue shows a moderator that it is already gone.
        <Alert color="yellow">
          <Text size="xs">
            We couldn&apos;t load this sticker — it may have just been removed. You can still send
            the report.
          </Text>
        </Alert>
      ) : (
        <Group gap={8} wrap="nowrap">
          {art && (
            <EdgeImage
              src={art.url}
              alt={`:${art.slug}:`}
              options={{ height: 96, anim: art.animated, optimized: true }}
              style={{ height: 48, width: 'auto' }}
            />
          )}
          {/* Named back, not chosen. Showing the sticker is the confirmation
              that the right one was flagged, which is the job the list did
              badly. */}
          <Text size="sm">
            Reporting {half === 'comment' ? 'the note on ' : ''}
            {data?.sticker?.name ? <strong>{data.sticker.name}</strong> : 'this sticker'}.
          </Text>
        </Group>
      )}

      <InputTextArea
        name="comment"
        label="What's wrong with it? (optional)"
        placeholder="Anything that helps a moderator decide"
      />
    </Stack>
  );
}

export const StickerPlacementForm = createReportForm({
  schema: reportStickerPlacementDetailsSchema,
  Element: StickerPlacementFields,
});
