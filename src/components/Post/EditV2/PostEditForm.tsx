import { useEffect } from 'react';
import { z } from 'zod';
import { Form, InputRTE, InputTextArea, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { useDebouncer } from '~/utils/debouncer';
import { EditPostTags } from '~/components/Post/EditV2/EditPostTags';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { Alert, Group, Badge } from '@mantine/core';
import { CollectionSelectDropdown } from '~/components/Post/EditV2/Collections/CollectionSelectDropdown';
import { isDefined } from '~/utils/type-guards';
import { useDomainSettings } from '~/providers/DomainSettingsProvider';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';

const titleCharLimit = 255;
const formSchema = z.object({ title: z.string().nullish(), detail: z.string().nullish() });

export function PostEditForm() {
  const post = usePostEditStore((state) => state.post);
  const images = usePostEditStore((state) => state.images);
  const domainSettings = useDomainSettings();
  const { postTitle, collectionId } = usePostEditParams();
  const form = useForm({
    schema: formSchema,
    defaultValues: { ...post, title: post?.title ?? postTitle },
  });
  const debounce = useDebouncer(1000);

  const { mutate } = trpc.post.update.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Failed to update post',
        error: new Error(error.message),
      });
    },
  });

  useEffect(() => {
    const subscription = form.watch(({ title, detail }, { name }) => {
      if (!post) return;
      const state = name ? form.getFieldState(name) : ({} as ReturnType<typeof form.getFieldState>);
      if (state.isDirty || state.isTouched)
        debounce(() =>
          mutate({
            id: post.id,
            title:
              title && title.length > titleCharLimit ? title.substring(0, titleCharLimit) : title,
            detail,
          })
        );
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []); // eslint-disable-line

  const controls = [
    'heading',
    'formatting',
    'list',
    'link',
    collectionId ? undefined : 'media',
    'mentions',
  ].filter(isDefined);

  const hasNotAvailableNsfwLevels = images.some((image) => {
    return (
      image.type === 'added' &&
      !domainSettings.allowedNsfwLevels.some(
        (l) => image.data.nsfwLevel === 0 || l === image.data.nsfwLevel
      )
    );
  });

  return (
    <Form form={form} className="flex flex-col gap-3">
      {hasNotAvailableNsfwLevels && (
        <Alert color="red">
          <div className="flex flex-col gap-2">
            <p>
              Some images&rsquo; rating levels are not available in this domain. This means that
              users will not be able to see them unelss they access the relevant Civitai domain.
            </p>
            <p>Rating levels avialable on this domain are as follows</p>
            <div className="flex flex-wrap gap-2">
              {domainSettings.allowedNsfwLevels.map((level) => (
                <Badge key={level} color="dark" variant="filled">
                  {browsingLevelLabels[level]}
                </Badge>
              ))}
            </div>
          </div>
        </Alert>
      )}
      <InputTextArea
        data-tour="post:title"
        name="title"
        placeholder="Add a title..."
        size="xl"
        variant="unstyled"
        styles={{ input: { fontWeight: 600, padding: 0 } }}
        autosize
      />
      <Group spacing="sm">{post && <EditPostTags post={post} autosuggest={false} />}</Group>
      <CollectionSelectDropdown />
      <InputRTE
        name="detail"
        placeholder="Add a description..."
        // Remove the `media` controls when the post is part of a collection.
        // @ts-ignore - `includeControls` does not export types.
        includeControls={controls}
        editorSize="md"
        data-tour="post:description"
      />
    </Form>
  );
}
