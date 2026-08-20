import { useEffect } from 'react';
import * as z from 'zod';
import { Form, InputRTE, InputTextArea, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { useDebouncer } from '~/utils/debouncer';
import { EditPostTags } from '~/components/Post/EditV2/EditPostTags';
import {
  usePendingSave,
  usePostEditParams,
  usePostEditStore,
} from '~/components/Post/EditV2/PostEditProvider';

import { Group } from '@mantine/core';
import { CollectionSelectDropdown } from '~/components/Post/EditV2/Collections/CollectionSelectDropdown';
import { isDefined } from '~/utils/type-guards';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';

const titleCharLimit = 255;
const formSchema = z.object({ title: z.string().nullish(), detail: z.string().nullish() });

export function PostEditForm() {
  const post = usePostEditStore((state) => state.post);
  const updatePost = usePostEditStore((state) => state.updatePost);
  const { postTitle, collectionId } = usePostEditParams();
  const form = useForm({
    schema: formSchema,
    defaultValues: { ...post, title: post?.title ?? postTitle },
  });
  const debounce = useDebouncer(1000);

  const { mutate } = trpc.post.update.useMutation({
    // Applied when the request is SENT, not when it lands. The provider snapshots the store into
    // the `post.getEdit` cache on `routeChangeStart` and nothing refetches it (staleTime is
    // Infinity), so a save flushed on the way out would otherwise still be in flight when that
    // snapshot is taken — the next visit then seeds the form from the pre-edit values and its
    // first autosave writes them back over the server.
    onMutate({ title, detail }) {
      let previous: { title: string | null; detail: string | null } | undefined;
      updatePost((data) => {
        previous = { title: data.title ?? null, detail: data.detail ?? null };
        if (title !== undefined) data.title = title ?? null;
        if (detail !== undefined) data.detail = detail ?? null;
      });
      return previous;
    },
    onError(error, { title, detail }, previous) {
      // Roll back, or the store keeps a value the server rejected and hands it to the
      // `post.getEdit` cache on the way out — claiming a save that never landed. Each field
      // is restored only if it still holds what THIS request set, so a later edit that
      // succeeded while this one was failing isn't clobbered.
      updatePost((data) => {
        if (!previous) return;
        if (title !== undefined && data.title === (title ?? null)) data.title = previous.title;
        if (detail !== undefined && data.detail === (detail ?? null)) data.detail = previous.detail;
      });
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

  usePendingSave('post-detail', debounce);

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
