import { Textarea, Text } from '@mantine/core';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { useEditPostContext } from './EditPostProvider';
import { trpc } from '~/utils/trpc';
import { useEffect, useRef } from 'react';

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
  // const [debounced] = useDebouncedValue(title, 1000);
  const { mutate, isLoading } = trpc.post.update.useMutation();
  // const ref = useRef<HTMLSpanElement>(null);

  const handleChange = (title: string) => {
    const clipped = title.length > charLimit ? title.substring(0, charLimit) : title;
    setTitle(clipped);
    debounce(() => mutate({ id, title: clipped }));
  };

  // useDidUpdate(() => {
  //   console.log('did update');
  //   mutate({ id, title: debounced });
  // }, [debounced, id]);

  // useEffect(() => {
  //   const onPaste = (e: ClipboardEvent) => {
  //     // cancel paste
  //     e.preventDefault();

  //     // get text representation of clipboard
  //     const text = e.clipboardData?.getData('text/plain');

  //     // insert text manually
  //     e.target.
  //   };
  // }, []);

  // return (
  //   <Text
  //     contentEditable
  //     size="xl"
  //     color={!title.length ? 'dimmed' : undefined}
  //     placeholder="Add a title..."
  //     style={{ outline: 'none' }}
  //     component="span"
  //   ></Text>
  // );

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
