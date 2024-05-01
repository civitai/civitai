import { useEffect } from 'react';
import { z } from 'zod';
import { Form, InputRTE, InputTextArea, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { useDebouncer } from '~/utils/debouncer';
import { EditPostTags } from '~/components/Post/EditV2/EditPostTags';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';

const titleCharLimit = 255;
const formSchema = z.object({ title: z.string().nullish(), detail: z.string().nullish() });

export function PostEditForm() {
  const post = usePostEditStore((state) => state.post);
  const { postTitle } = usePostEditParams();
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

  return (
    <Form form={form} className="flex flex-col gap-3">
      <InputTextArea
        name="title"
        placeholder="Add a title..."
        size="xl"
        variant="unstyled"
        styles={{ input: { fontWeight: 600, padding: 0 } }}
        autosize
      />
      {post && <EditPostTags post={post} />}
      <InputRTE
        name="detail"
        placeholder="Add a description..."
        includeControls={['heading', 'formatting', 'list', 'link', 'media', 'mentions']}
        editorSize="md"
      />
    </Form>
  );
}
