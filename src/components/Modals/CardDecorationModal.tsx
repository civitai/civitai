import { Button, Center, Grid, Loader, Modal, Stack } from '@mantine/core';
import { z } from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputCosmeticSelect, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { UseQueryModelReturn } from '~/components/Model/model.utils';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { FeedCard } from '~/components/Cards/FeedCard';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';

const schema = z.object({
  contentDecorationId: z.number().nullish(),
  entityId: z.number(),
  entityType: z.enum(['model', 'media', 'article']),
});

export function CardDecorationModal({ data, entityType }: Props) {
  const currentUser = useCurrentUser();
  const dialog = useDialogContext();
  const form = useForm({ schema });

  const { data: userCosmetics, isInitialLoading } = trpc.user.getCosmetics.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const handleSubmit = (data: z.infer<typeof schema>) => {
    console.log(data);
  };

  const { isDirty } = form.formState;
  const contentDecorationId = form.watch('contentDecorationId');
  const items = userCosmetics?.contentDecorations.filter(({ data }) => data.url) ?? [];
  const selectedItem = items.find((item) => item.id === contentDecorationId);

  return (
    <Modal
      {...dialog}
      title="Card Decoration"
      closeButtonLabel="Close card decoration modal"
      size="lg"
    >
      <Form form={form} onSubmit={handleSubmit}>
        <Grid gutter="xl">
          <Grid.Col xs={12} md={6} orderMd={1} orderSm={2}>
            {isInitialLoading ? (
              <Center>
                <Loader />
              </Center>
            ) : (
              <Stack>
                <InputCosmeticSelect
                  name="contentDecorationId"
                  data={items}
                  shopUrl="/shop/content-decorations"
                  gridProps={{
                    breakpoints: [
                      { cols: 1, maxWidth: 'xs' },
                      { cols: 2, minWidth: 'sm' },
                      { cols: 3, minWidth: 'md' },
                    ],
                  }}
                />
                <Button
                  radius="xl"
                  type="submit"
                  w="80%"
                  mx="auto"
                  sx={showMobile}
                  disabled={isInitialLoading || !isDirty}
                >
                  Apply
                </Button>
              </Stack>
            )}
          </Grid.Col>
          <Grid.Col xs={12} md={6} orderMd={2} orderSm={1}>
            <Stack>
              <PreviewCard data={data} decoration={selectedItem} />
              <Button
                radius="xl"
                type="submit"
                w="80%"
                mx="auto"
                sx={hideMobile}
                disabled={isInitialLoading || !isDirty}
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

type Props =
  | { entityType: 'model'; data: UseQueryModelReturn[number] }
  | { entityType: 'media'; data: ImagesInfiniteModel };

const PreviewCard = ({
  data,
  decoration,
}: Pick<Props, 'data'> & { decoration?: BadgeCosmetic }) => {
  const image = 'images' in data ? data.images[0] : data;
  const originalAspectRatio = image.width && image.height ? image.width / image.height : 1;
  const imageWidth =
    originalAspectRatio > 1
      ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
      : DEFAULT_EDGE_IMAGE_WIDTH;

  const { classes } = useCardStyles({ aspectRatio: originalAspectRatio });

  return (
    <FeedCard cardDecoration={decoration}>
      <ImageGuard2 image={image}>
        {() => <EdgeMedia src={image.url} className={classes.image} width={imageWidth} />}
      </ImageGuard2>
    </FeedCard>
  );
};
