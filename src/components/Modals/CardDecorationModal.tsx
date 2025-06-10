import { Button, Center, Grid, Group, Loader, Modal, Paper, Stack } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { IconArrowRight } from '@tabler/icons-react';
import { z } from 'zod';

import cardClasses from '~/components/Cards/Cards.module.css';
import {
  useEquipContentDecoration,
  useQueryUserCosmetics,
} from '~/components/Cosmetics/cosmetics.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Form, InputCosmeticSelect, useForm } from '~/libs/form';
import { DEFAULT_EDGE_IMAGE_WIDTH, constants } from '~/server/common/constants';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { cosmeticInputSchema } from '~/server/schema/cosmetic.schema';
import classes from './CardDecorationModal.module.scss';

const schema = z.object({
  cosmetic: cosmeticInputSchema.nullish(),
});

export default function CardDecorationModal({
  entityType,
  entityId,
  image,
  currentCosmetic,
}: Props) {
  const dialog = useDialogContext();
  const form = useForm({ schema, defaultValues: { cosmetic: currentCosmetic } });

  const { data: userCosmetics, isInitialLoading } = useQueryUserCosmetics();

  const { equip, unequip, isLoading } = useEquipContentDecoration();
  const handleSubmit = async ({ cosmetic }: z.infer<typeof schema>) => {
    const unequipping = currentCosmetic && !cosmetic;

    if (unequipping && currentCosmetic) {
      await unequip({
        equippedToId: entityId,
        equippedToType: entityType,
        cosmeticId: currentCosmetic.id,
        claimKey: currentCosmetic.claimKey,
      }).catch(() => null); // error is handled in the custom hook
      dialog.onClose();
      return;
    }

    async function completeSubmission() {
      if (cosmetic)
        await equip({
          equippedToId: entityId,
          equippedToType: entityType,
          cosmeticId: cosmetic.id,
          claimKey: cosmetic.claimKey,
        }).catch(() => null); // error is handled in the custom hook

      dialog.onClose();
    }

    if (selectedItem && selectedItem.inUse) {
      return openConfirmModal({
        title: 'Reassign Content Decoration',
        children:
          'This content decoration is being used on another post. Are you sure you want to reassign it?',
        labels: { confirm: 'Continue', cancel: 'No, go back' },
        onConfirm: completeSubmission,
        zIndex: 310,
      });
    }

    await completeSubmission();
  };

  const handleClose = () => {
    if (isLoading) return;
    dialog.onClose();
  };

  const { isDirty } = form.formState;
  const cosmetic = form.watch('cosmetic');
  const items =
    userCosmetics?.contentDecorations.filter(
      ({ data, forId, forType }) =>
        (data.url || data.cssFrame) &&
        // Ensure we only show cosmetics available for this item.
        (!forId || (forId && forType && forId === entityId && forType === entityType))
    ) ?? [];
  const selectedItem = items.find(
    (item) => item.id === cosmetic?.id && item.claimKey === cosmetic?.claimKey
  );

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      title="Content Decorations"
      closeButtonProps={{
        'aria-label': 'Close content decorations modal',
      }}
      size="lg"
      closeOnClickOutside={!isLoading}
      closeOnEscape={!isLoading}
    >
      <Form form={form} onSubmit={handleSubmit}>
        <Grid gutter="xl">
          <Grid.Col span={{ base: 12, sm: 6 }} className={classes.decorations}>
            {isInitialLoading ? (
              <Center>
                <Loader />
              </Center>
            ) : (
              <Stack>
                <InputCosmeticSelect
                  name="cosmetic"
                  data={items}
                  shopUrl="/shop"
                  gridProps={{
                    cols: 3,
                  }}
                />
                <Button
                  radius="xl"
                  type="submit"
                  w="80%"
                  mx="auto"
                  className={classes.showMobile}
                  disabled={isInitialLoading || !isDirty}
                >
                  Apply
                </Button>
              </Stack>
            )}
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6 }} className={classes.preview}>
            <Stack align="center" gap="xl">
              {selectedItem &&
                selectedItem.entityImage &&
                (selectedItem.entityImage.entityId !== entityId ||
                  selectedItem.entityImage.entityType !== entityType) && (
                  <Group wrap="nowrap">
                    <Paper className="overflow-hidden" radius="md" w={48} h={62}>
                      <EdgeMedia2
                        src={selectedItem.entityImage.url}
                        thumbnailUrl={selectedItem.entityImage.thumbnailUrl}
                        type={selectedItem.entityImage.type}
                        width={DEFAULT_EDGE_IMAGE_WIDTH}
                        alt="current item with decoration"
                        className="size-full object-cover"
                        wrapperProps={{ className: 'h-full' }}
                        skip={4}
                      />
                    </Paper>
                    <IconArrowRight size={24} style={{ flexShrink: 0 }} />
                    <Paper className="overflow-hidden" radius="md" w={48} h={62}>
                      <EdgeMedia2
                        src={image.url}
                        thumbnailUrl={image.thumbnailUrl}
                        type={image.type}
                        width={DEFAULT_EDGE_IMAGE_WIDTH}
                        alt="new item with decoration"
                        className="size-full object-cover"
                        wrapperProps={{ className: 'h-full' }}
                        skip={4}
                        contain
                      />
                    </Paper>
                  </Group>
                )}
              <PreviewCard image={image} decoration={selectedItem} />
              <Button
                radius="xl"
                type="submit"
                w="80%"
                mx="auto"
                className={classes.hideMobile}
                disabled={isInitialLoading || !isDirty}
                loading={isLoading}
              >
                Apply
              </Button>
            </Stack>
          </Grid.Col>
        </Grid>
      </Form>
    </Modal>
  );
}

export type Props = {
  entityType: CosmeticEntity;
  entityId: number;
  image: Pick<ImageProps, 'id' | 'url' | 'width' | 'height' | 'name' | 'type' | 'thumbnailUrl'>;
  currentCosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
};

export const PreviewCard = ({
  image,
  decoration,
}: Pick<Props, 'image'> & { decoration?: ContentDecorationCosmetic }) => {
  const originalAspectRatio = image && image.width && image.height ? image.width / image.height : 1;
  const imageWidth =
    originalAspectRatio > 1
      ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
      : DEFAULT_EDGE_IMAGE_WIDTH;

  if (!image) return null;

  const heightRatio = image.height && image.width ? image.height / image.width : 1;
  const cardHeight = heightRatio * constants.cardSizes.image;

  return (
    <MasonryCard height={cardHeight} frameDecoration={decoration}>
      <EdgeMedia2
        src={image.url}
        type={image.type}
        className={cardClasses.image}
        width={imageWidth}
        wrapperProps={{ className: 'h-full' }}
        anim
        contain
      />
    </MasonryCard>
  );
};
