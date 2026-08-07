import { Alert, Text } from '@mantine/core';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useReportTarget } from '~/components/Report/report-target.context';
import { createReportForm } from '~/components/Report/create-report-form';
import { useStickerPlacements } from '~/components/Sticker/placement.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { InputRadioGroup, InputTextArea } from '~/libs/form';
import { reportStickerPlacementDetailsSchema } from '~/server/schema/report.schema';
import { Radio, Stack, Group } from '@mantine/core';

/**
 * Reporting a sticker someone placed on this image.
 *
 * The reporter picks the placement. An image can carry several, and a report
 * that only says "a sticker here is abusive" makes a moderator guess — the wrong
 * guess removes an innocent person's sticker and takes their Buzz with it.
 */
function StickerPlacementFields() {
  const target = useReportTarget();
  const imageIds = target ? [target.entityId] : [];
  const { byImage } = useStickerPlacements(imageIds, !!target);
  const placements = target ? byImage.get(target.entityId) ?? [] : [];
  const { sticker } = useStickerCosmetics(placements.map((p) => p.data.cosmeticId));

  // The field stays mounted with no options rather than being replaced by the
  // alert. `placementId` is required and Submit lives in the parent modal, so an
  // unmounted field meant pressing Submit failed validation with nowhere to
  // render the error — the button simply did nothing.
  if (!placements.length)
    return (
      <Stack gap="xs">
        <Alert color="yellow">
          <Text size="xs">
            There are no stickers on this image right now. If one was just removed, there is nothing
            left to report.
          </Text>
        </Alert>
        <InputRadioGroup name="placementId" label="Which sticker?" withAsterisk>
          <div />
        </InputRadioGroup>
      </Stack>
    );

  return (
    <Stack gap="xs">
      <InputRadioGroup name="placementId" label="Which sticker?" withAsterisk>
        <Stack gap={4}>
          {placements.map((placement) => {
            const art = sticker.get(placement.data.cosmeticId);
            return (
              <Radio
                key={placement.id}
                value={String(placement.id)}
                label={
                  <Group gap={6} wrap="nowrap">
                    {art && (
                      <EdgeImage
                        src={art.url}
                        alt={`:${art.slug}:`}
                        options={{ height: 64, anim: art.animated, optimized: true }}
                        style={{ height: 32, width: 'auto' }}
                      />
                    )}
                    <Text size="xs">{art ? `:${art.slug}:` : `Placement ${placement.id}`}</Text>
                  </Group>
                }
              />
            );
          })}
        </Stack>
      </InputRadioGroup>

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
