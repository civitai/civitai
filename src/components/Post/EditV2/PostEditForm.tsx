import { useEffect } from 'react';
import * as z from 'zod/v4';
import { Form, InputRTE, InputTextArea, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { useDebouncer } from '~/utils/debouncer';
import { EditPostTags } from '~/components/Post/EditV2/EditPostTags';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';

import { Group } from '@mantine/core';
import { CollectionSelectDropdown } from '~/components/Post/EditV2/Collections/CollectionSelectDropdown';
import { isDefined } from '~/utils/type-guards';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';

const titleCharLimit = 255;
const formSchema = z.object({ title: z.string().nullish(), detail: z.string().nullish() });

export function PostEditForm() {
  const post = usePostEditStore((state) => state.post);
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

  return (
    <Form form={form} className="flex flex-col gap-3">
      <ReadOnlyAlert
        message={
          "Civitai is currently in read-only mode and you won't be able to publish or see changes made to this post."
        }
      />
      <InputTextArea
        data-tour="post:title"
        name="title"
        placeholder="Add a title..."
        size="xl"
        variant="unstyled"
        styles={{ input: { fontWeight: 600, padding: 0 } }}
        autosize
      />
      <Group gap="sm">{post && <EditPostTags post={post} autosuggest={false} />}</Group>
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
