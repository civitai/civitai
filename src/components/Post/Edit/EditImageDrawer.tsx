import {
  Drawer,
  useMantineTheme,
  Stack,
  Checkbox,
  Tooltip,
  Text,
  TooltipProps,
} from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useForm } from '~/libs/form';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { PostImage } from '~/server/selectors/post.selector';
import { trpc } from '~/utils/trpc';

const matureLabel = 'Mature content may include content that is suggestive or provocative';
const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

export function EditImageDrawer({ imageId, onClose }: { imageId?: number; onClose: () => void }) {
  const mobile = useIsMobile();
  const theme = useMantineTheme();

  return (
    <Drawer
      opened={!!imageId}
      onClose={onClose}
      position={mobile ? 'bottom' : 'right'}
      title={'Image details'}
      size={mobile ? '100%' : 'xl'}
      padding="md"
      shadow="sm"
      zIndex={500}
      styles={{
        drawer: {
          borderLeft: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
          }`,
        },
      }}
    >
      {imageId ? <EditImage imageId={imageId} /> : <NotFound />}
    </Drawer>
  );
}
export function EditImage({ imageId }: { imageId: number }) {
  const images = useEditPostContext((state) => state.images);
  const setImage = useEditPostContext((state) => state.setImage);
  const image = images.find((x) => x.type === 'image' && x.data.id === imageId)?.data as
    | PostImage
    | undefined;

  const form = useForm({ schema: imageMetaSchema, defaultValues: image?.meta as any });

  if (!image) return <NotFound />;

  return (
    <Stack>
      <Checkbox
        checked={image.nsfw}
        onChange={(e) => setImage(image.id, (image) => ({ ...image, nsfw: e.target.checked }))}
        label={
          <Text>
            Mature Content{' '}
            <Tooltip label={matureLabel} {...tooltipProps}>
              <Text component="span">(?)</Text>
            </Tooltip>
          </Text>
        }
      />
      <Checkbox label="Hide generation data" />
    </Stack>
  );
}

function ImageNsfwCheckbox() {
  const { mutate, isLoading } = trpc.image.update.useMutation();
}
