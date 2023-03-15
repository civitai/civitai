import { useEditPostContext } from './EditPostProvider';
import { trpc } from '~/utils/trpc';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';

let timer: NodeJS.Timeout | undefined;
const debounce = (func: () => void, timeout = 1000) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    func();
  }, timeout);
};

export function EditPostDetail() {
  const id = useEditPostContext((state) => state.id);
  const detail = useEditPostContext((state) => state.detail ?? '');
  const setDetail = useEditPostContext((state) => state.setDetail);
  const { mutate } = trpc.post.update.useMutation();

  const handleChange = (detail: string) => {
    setDetail(detail);
    debounce(() => mutate({ id, detail }));
  };

  return (
    <RichTextEditor
      placeholder="Add a description..."
      value={detail}
      onChange={(value) => handleChange(value)}
      includeControls={['heading', 'formatting', 'list', 'link', 'media', 'mentions']}
      editorSize="md"
    />
  );
}
