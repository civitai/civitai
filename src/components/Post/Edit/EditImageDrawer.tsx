import {
  Drawer,
  Stack,
  Tooltip,
  Text,
  TooltipProps,
  Grid,
  Input,
  Button,
  Card,
  Group,
  Badge,
  ScrollArea,
  CloseButton,
} from '@mantine/core';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { InputCheckbox, useForm, Form, InputTextArea, InputNumber, InputSelect } from '~/libs/form';
import { imageGenerationSchema, imageMetaSchema } from '~/server/schema/image.schema';
import { PostImage } from '~/server/selectors/post.selector';
import { trpc } from '~/utils/trpc';
import { splitUppercase } from '~/utils/string-helpers';
import { IconVersions } from '@tabler/icons';
import { showSuccessNotification } from '~/utils/notifications';

const matureLabel = 'Mature content may include content that is suggestive or provocative';
const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

const schema = z.object({
  nsfw: z.boolean().default(false),
  hideMeta: z.boolean().default(false),
  meta: imageGenerationSchema.partial(),
});

export function EditImageDrawer() {
  const mobile = useIsMobile();
  const imageId = useEditPostContext((state) => state.selectedImageId);
  const setSelectedImageId = useEditPostContext((state) => state.setSelectedImageId);

  const handleClose = () => setSelectedImageId(undefined);

  return (
    <Drawer
      opened={!!imageId}
      onClose={handleClose}
      position={mobile ? 'bottom' : 'right'}
      // title={'Image details'}
      size={mobile ? '100%' : 'xl'}
      padding={0}
      shadow="sm"
      withCloseButton={false}
      styles={{
        body: {
          height: '100%',
        },
      }}
    >
      {imageId ? <EditImage imageId={imageId} onClose={handleClose} /> : <NotFound />}
    </Drawer>
  );
}
export function EditImage({ imageId, onClose }: { imageId: number; onClose: () => void }) {
  const images = useEditPostContext((state) => state.images);
  const setImage = useEditPostContext((state) => state.setImage);
  const image = images.find((x) => x.type === 'image' && x.data.id === imageId)?.data as
    | PostImage
    | undefined;

  const form = useForm({ schema, defaultValues: image as any, mode: 'onChange' });
  const { mutate, isLoading } = trpc.post.updateImage.useMutation();

  const handleSubmit = (data: z.infer<typeof schema>) => {
    if (!image) return;
    const meta = { ...(image.meta as z.infer<typeof imageMetaSchema>), ...data.meta };
    const payload = { ...image, ...data, meta };
    if (!Object.keys(form.formState.dirtyFields).length) {
      onClose();
      showSuccessNotification({ message: 'Image details saved successfully' });
    } else {
      mutate(payload, {
        onSuccess: (response) => {
          showSuccessNotification({ message: 'Image details saved successfully' });
          setImage(response.id, () => response);
          onClose();
        },
      });
    }
  };

  if (!image) return <NotFound />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Group
        px="md"
        py="sm"
        position="apart"
        noWrap
        sx={(theme) => ({
          borderBottom: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
          }`,
        })}
      >
        <Text>Image Details</Text>
        <CloseButton onClick={onClose} />
      </Group>
      <ScrollArea offsetScrollbars pl="md" pr={4} style={{ flex: 1 }}>
        <Form id="image-detail" form={form} onSubmit={handleSubmit}>
          <Stack spacing="xl" pt="md" pb={4}>
            <ImagePreview
              image={image}
              edgeImageProps={{ width: 220 }}
              aspectRatio={1}
              style={{ maxWidth: 110 }}
            />
            <Stack spacing="xs">
              <InputCheckbox
                name="nsfw"
                label={
                  <Text>
                    Mature Content{' '}
                    <Tooltip label={matureLabel} {...tooltipProps}>
                      <Text component="span">(?)</Text>
                    </Tooltip>
                  </Text>
                }
              />
              <InputCheckbox name="hideMeta" label="Hide generation data" />
            </Stack>
            <Input.Wrapper label="Resources">
              {image.resources.map((r) => (
                <Card key={r.id} p={8} withBorder>
                  {r.modelVersion && (
                    <Stack>
                      <Group spacing={4} position="apart" noWrap>
                        <Group spacing={4} noWrap>
                          <Text size="sm" weight={500} lineClamp={1}>
                            {r.modelVersion.model.name}
                          </Text>
                          {/* <IconVersions size={16} /> */}
                        </Group>
                        <Badge radius="sm" size="sm">
                          {splitUppercase(r.modelVersion.model.type)}
                        </Badge>
                      </Group>
                    </Stack>
                  )}
                </Card>
              ))}
            </Input.Wrapper>
            <Grid gutter="xs">
              <Grid.Col span={12}>
                <InputTextArea name="meta.prompt" label="Prompt" autosize maxRows={3} />
              </Grid.Col>
              <Grid.Col span={12}>
                <InputTextArea
                  name="meta.negativePrompt"
                  label="Negative prompt"
                  autosize
                  maxRows={3}
                />
              </Grid.Col>
              <Grid.Col span={6}>
                <InputNumber name="meta.cfgSchale" label="Guidance scale" min={0} max={30} />
              </Grid.Col>
              <Grid.Col span={6}>
                <InputNumber name="meta.steps" label="Steps" />
              </Grid.Col>
              <Grid.Col span={6}>
                <InputSelect
                  name="meta.sampler"
                  clearable
                  searchable
                  data={[
                    'Euler a',
                    'Euler',
                    'LMS',
                    'Heun',
                    'DPM2',
                    'DPM2 a',
                    'DPM++ 2S a',
                    'DPM++ 2M',
                    'DPM++ SDE',
                    'DPM fast',
                    'DPM adaptive',
                    'LMS Karras',
                    'DPM2 Karras',
                    'DPM2 a Karras',
                    'DPM++ 2S a Karras',
                    'DPM++ 2M Karras',
                    'DPM++ SDE Karras',
                    'DDIM',
                    'PLMS',
                  ]}
                  label="Sampler"
                />
              </Grid.Col>
              <Grid.Col span={6}>
                <InputNumber name="meta.seed" label="Seed" />
              </Grid.Col>
            </Grid>
          </Stack>
        </Form>
      </ScrollArea>
      <Stack
        py="xs"
        px="md"
        sx={(theme) => ({
          borderTop: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
          }`,
        })}
      >
        <Button type="submit" loading={isLoading} form="image-detail">
          Save
        </Button>
      </Stack>
    </div>
  );
}
