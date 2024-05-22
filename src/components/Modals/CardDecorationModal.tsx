import {
  Button,
  Center,
  Grid,
  Group,
  Image,
  Loader,
  Modal,
  Stack,
  createStyles,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { CosmeticEntity } from '@prisma/client';
import { IconArrowRight } from '@tabler/icons-react';
import { truncate } from 'lodash';
import { z } from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

import { useCardStyles } from '~/components/Cards/Cards.styles';
import {
  useEquipContentDecoration,
  useQueryUserCosmetics,
} from '~/components/Cosmetics/cosmetics.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Form, InputCosmeticSelect, useForm } from '~/libs/form';
import { DEFAULT_EDGE_IMAGE_WIDTH, constants } from '~/server/common/constants';
import { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { cosmeticInputSchema } from '~/server/schema/cosmetic.schema';

const useStyles = createStyles((theme) => ({
  preview: {
    order: 1,

    [containerQuery.largerThan('xs')]: {
      order: 2,
    },
  },

  decorations: {
    order: 2,

    [theme.fn.largerThan('xs')]: {
      order: 1,
    },
  },

  hideMobile: {
    [theme.fn.smallerThan('xs')]: {
      display: 'none',
    },
  },

  showMobile: {
    [theme.fn.largerThan('xs')]: {
      display: 'none',
    },
  },
}));

const schema = z.object({
  cosmetic: cosmeticInputSchema.nullish(),
});

export function CardDecorationModal({ entityType, entityId, image, currentCosmetic }: Props) {
  const dialog = useDialogContext();
  const form = useForm({ schema, defaultValues: { cosmetic: currentCosmetic } });
  const { classes } = useStyles();

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
      closeButtonLabel="Close content decorations modal"
      size="lg"
      closeOnClickOutside={!isLoading}
      closeOnEscape={!isLoading}
    >
      <Form form={form} onSubmit={handleSubmit}>
        <Grid gutter="xl">
          <Grid.Col xs={12} sm={6} className={classes.decorations}>
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
                    breakpoints: [{ cols: 3, minWidth: 'xs' }],
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
          <Grid.Col xs={12} sm={6} className={classes.preview}>
            <Stack align="center" spacing="xl">
              {selectedItem &&
                selectedItem.entityImage &&
                (selectedItem.entityImage.entityId !== entityId ||
                  selectedItem.entityImage.entityType !== entityType) && (
                  <Group noWrap>
                    <Image
                      src={getEdgeUrl(selectedItem.entityImage.url, {
                        transcode: false,
                        anim: false,
                      })}
                      alt={
                        selectedItem.entityImage.meta
                          ? truncate(selectedItem.entityImage.meta.prompt, {
                              length: constants.altTruncateLength,
                            })
                          : undefined
                      }
                      radius="md"
                      width={48}
                      height={62}
                    />
                    <IconArrowRight size={24} style={{ flexShrink: 0 }} />
                    <Image
                      src={getEdgeUrl(image.url, {
                        transcode: false,
                        anim: false,
                      })}
                      alt={
                        image.meta
                          ? truncate(image.meta.prompt, {
                              length: constants.altTruncateLength,
                            })
                          : undefined
                      }
                      radius="md"
                      width={48}
                      height={62}
                    />
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
  image: Pick<ImageProps, 'id' | 'url' | 'width' | 'height' | 'meta'>;
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

  const { classes } = useCardStyles({ aspectRatio: originalAspectRatio });

  if (!image) return null;

  const heightRatio = image.height && image.width ? image.height / image.width : 1;
  const cardHeight = heightRatio * constants.cardSizes.image;

  return (
    <MasonryCard
      height={cardHeight}
      frameDecoration={decoration}
      className={decoration && classes.frameAdjustment}
    >
      <EdgeMedia src={image.url} className={classes.image} width={imageWidth} anim={true} />
    </MasonryCard>
  );
};
