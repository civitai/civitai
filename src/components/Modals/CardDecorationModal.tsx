import { Button, Center, Grid, Loader, Modal, Stack, createStyles } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { CosmeticEntity } from '@prisma/client';
import { z } from 'zod';

import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import {
  useEquipContentDecoration,
  useQueryUserCosmetics,
} from '~/components/Cosmetics/cosmetics.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { UseQueryModelReturn } from '~/components/Model/model.utils';
import { Form, InputCosmeticSelect, useForm } from '~/libs/form';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';
import { ArticleGetAll } from '~/server/services/article.service';
import { PostsInfiniteModel } from '~/server/services/post.service';
import { containerQuery } from '~/utils/mantine-css-helpers';

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
  cosmeticId: z.number().nullish(),
});

export function CardDecorationModal({ data, entityType }: Props) {
  const dialog = useDialogContext();
  const form = useForm({ schema, defaultValues: { cosmeticId: data.cosmetic?.id ?? null } });
  const { classes } = useStyles();

  const { data: userCosmetics, isInitialLoading } = useQueryUserCosmetics();

  const { equip, unequip, isLoading } = useEquipContentDecoration();
  const handleSubmit = async ({ cosmeticId }: z.infer<typeof schema>) => {
    const unequipping = data.cosmetic && !cosmeticId;

    if (unequipping && data.cosmetic) {
      await unequip({
        equippedToId: data.id,
        equippedToType: entityType,
        cosmeticId: data.cosmetic.id,
      }).catch(() => null); // error is handled in the custom hook
      dialog.onClose();
      return;
    }

    async function completeSubmission() {
      if (cosmeticId)
        await equip({ equippedToId: data.id, equippedToType: entityType, cosmeticId }).catch(
          () => null
        ); // error is handled in the custom hook

      dialog.onClose();
    }

    if (selectedItem && selectedItem.inUse) {
      return openConfirmModal({
        title: 'Reassign Art Frame',
        children:
          'This art frame is being used on another post. Are you sure you want to reassign it?',
        labels: { confirm: 'Continue', cancel: 'No, go back' },
        onConfirm: completeSubmission,
      });
    }

    await completeSubmission();
  };

  const { isDirty } = form.formState;
  const cosmeticId = form.watch('cosmeticId');
  const items = userCosmetics?.contentDecorations.filter(({ data }) => data.url) ?? [];
  const selectedItem = items.find((item) => item.id === cosmeticId);

  return (
    <Modal
      {...dialog}
      title="Card Decoration"
      closeButtonLabel="Close card decoration modal"
      size="lg"
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
                  name="cosmeticId"
                  data={items}
                  shopUrl="/shop/content-decorations"
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
            <Stack>
              <PreviewCard data={data} decoration={selectedItem} />
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
  data:
    | PostsInfiniteModel
    | Omit<ArticleGetAll[number], 'stats'>
    | ImageProps
    | UseQueryModelReturn[number];
};

const PreviewCard = ({
  data,
  decoration,
}: Pick<Props, 'data'> & { decoration?: BadgeCosmetic }) => {
  const image = 'images' in data ? data.images[0] : 'coverImage' in data ? data.coverImage : data;
  const originalAspectRatio = image && image.width && image.height ? image.width / image.height : 1;
  const imageWidth =
    originalAspectRatio > 1
      ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
      : DEFAULT_EDGE_IMAGE_WIDTH;

  const { classes } = useCardStyles({ aspectRatio: originalAspectRatio });

  if (!image) return null;

  return (
    <FeedCard frameDecoration={decoration}>
      <ImageGuard2 image={image}>
        {() => <EdgeMedia src={image.url} className={classes.image} width={imageWidth} />}
      </ImageGuard2>
    </FeedCard>
  );
};
