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
  Alert,
  ActionIcon,
  Popover,
} from '@mantine/core';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { InputCheckbox, useForm, Form, InputTextArea, InputNumber, InputSelect } from '~/libs/form';
import { imageGenerationSchema, imageMetaSchema } from '~/server/schema/image.schema';

import { trpc } from '~/utils/trpc';
import { splitUppercase } from '~/utils/string-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { PostEditImage } from '~/server/controllers/post.controller';
import { TagType } from '@prisma/client';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { IconInfoCircle } from '@tabler/icons';

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
    | PostEditImage
    | undefined;

  const hasModerationTags = image?.tags.some((x) => x.type === TagType.Moderation);
  const meta: Record<string, unknown> = (image?.meta as Record<string, unknown>) ?? {};
  const defaultValues: z.infer<typeof schema> = {
    hideMeta: image?.hideMeta ?? false,
    nsfw: hasModerationTags ? true : image?.nsfw ?? false,
    meta: {
      prompt: meta.prompt ?? '',
      negativePrompt: meta.negativePrompt ?? '',
      cfgScale: meta.cfgScale ?? '',
      steps: meta.steps ?? '',
      sampler: meta.sampler ?? '',
      seed: meta.seed ?? '',
    } as any,
  };

  const form = useForm({ schema, defaultValues, mode: 'onChange' });
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
                disabled={hasModerationTags}
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
            <Input.Wrapper label="Tags">
              <Group spacing={4}>
                {!!image.tags.length ? (
                  image.tags.map((tag) => (
                    <Badge key={tag.id} color={tag.type === TagType.Moderation ? 'red' : undefined}>
                      {tag.name}
                    </Badge>
                  ))
                ) : (
                  <Alert color="yellow">
                    There are no tags associated with this image yet. Tags will be assigned to this
                    image soon.
                  </Alert>
                )}
              </Group>
            </Input.Wrapper>
            <Input.Wrapper label="Resources">
              {!!image.resourceHelper.length ? (
                <Stack>
                  <DismissibleAlert
                    id="not-all-resources"
                    color="blue"
                    title="Missing resources?"
                    content={
                      <>
                        Install the{' '}
                        <Text
                          component="a"
                          href="https://github.com/civitai/sd_civitai_extension"
                          target="_blank"
                          variant="link"
                        >
                          Civitai Extension for Automatic 1111 Stable Diffusion Web UI
                        </Text>{' '}
                        to automatically detect all the resources used in your images.
                      </>
                    }
                  />
                  {image.resourceHelper.map((resource) => (
                    <Card key={resource.id} p={8} withBorder>
                      <Stack>
                        <Group spacing={4} position="apart" noWrap align="flex-start">
                          <Group spacing={4} noWrap>
                            {resource.modelVersionId ? (
                              <Group spacing={4}>
                                {resource.modelName && (
                                  <Text size="sm" weight={500} lineClamp={1}>
                                    {resource.modelName}
                                  </Text>
                                )}
                                {resource.modelVersionName && (
                                  <Badge style={{ textTransform: 'none' }}>
                                    {resource.modelVersionName}
                                  </Badge>
                                )}
                              </Group>
                            ) : (
                              <Group spacing={4}>
                                <Popover width={300} withinPortal withArrow>
                                  <Popover.Target>
                                    <ActionIcon size="xs">
                                      <IconInfoCircle size={16} />
                                    </ActionIcon>
                                  </Popover.Target>
                                  <Popover.Dropdown>
                                    <Text>
                                      The detected image resource was not found in our system
                                    </Text>
                                  </Popover.Dropdown>
                                </Popover>
                                <Text size="sm" weight={500} lineClamp={1}>
                                  {resource.name}
                                </Text>
                              </Group>
                            )}
                            {/* <IconVersions size={16} /> */}
                          </Group>
                          {resource.modelType && (
                            <Badge radius="sm" size="sm">
                              {splitUppercase(resource.modelType)}
                            </Badge>
                          )}
                        </Group>
                      </Stack>
                    </Card>
                  ))}
                </Stack>
              ) : (
                <Alert color="yellow">
                  We could not detect any resources associated with this image. If this image is
                  based on a model hosted on Civitai, try creating this post from the model detail
                  page. For automatic image resource detection, try installing{' '}
                  <Text
                    component="a"
                    href="https://github.com/civitai/sd_civitai_extension"
                    target="_blank"
                    variant="link"
                  >
                    Civitai Extension for Automatic 1111 Stable Diffusion Web UI
                  </Text>
                </Alert>
              )}
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
                <InputNumber name="meta.cfgScale" label="Guidance scale" min={0} max={30} />
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
                    'UniPC',
                  ]}
                  label="Sampler"
                />
              </Grid.Col>
              <Grid.Col span={6}>
                <InputNumber name="meta.seed" label="Seed" format="default" />
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
