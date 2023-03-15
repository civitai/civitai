import { Textarea } from '@mantine/core';
import { useEditPostContext } from './EditPostProvider';
import { trpc } from '~/utils/trpc';

let timer: NodeJS.Timeout | undefined;
const debounce = (func: () => void, timeout = 1000) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    func();
  }, timeout);
};

const charLimit = 255;
export function EditPostTitle() {
  const id = useEditPostContext((state) => state.id);
  const title = useEditPostContext((state) => state.title ?? '');
  const setTitle = useEditPostContext((state) => state.setTitle);
  const { mutate } = trpc.post.update.useMutation();

  const handleChange = (title: string) => {
    const clipped = title.length > charLimit ? title.substring(0, charLimit) : title;
    setTitle(clipped);
    debounce(() => mutate({ id, title: clipped }));
  };

  return (
    <Textarea
      placeholder="Add a title..."
      value={title}
      onChange={(e) => handleChange(e.target.value)}
      size="xl"
      variant="unstyled"
      styles={{ input: { fontWeight: 600 } }}
      autosize
    />
  );
}
