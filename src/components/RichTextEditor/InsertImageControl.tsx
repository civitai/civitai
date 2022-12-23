import {
  RichTextEditor,
  RichTextEditorControlProps,
  useRichTextEditorContext,
} from '@mantine/tiptap';
import { IconPhoto } from '@tabler/icons';
import { useRef } from 'react';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';

export function InsertImageControl(props: Props) {
  const { editor } = useRichTextEditorContext();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { uploadToCF } = useCFImageUpload();

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = async (fileList: FileList) => {
    const files = Array.from(fileList);
    const images = await Promise.all(files.map((file) => uploadToCF(file)));

    if (images.length > 0)
      images.map((image) =>
        editor.commands.setImage({ src: getEdgeUrl(image.id, { width: 525 }) })
      );
  };

  return (
    <RichTextEditor.Control
      {...props}
      onClick={handleClick}
      aria-label="Insert Image"
      title="Insert Image"
    >
      <IconPhoto size={16} stroke={1.5} />
      <input
        type="file"
        accept=".jpg,.jpeg,.png,.gif,.svg,.webp"
        ref={inputRef}
        onChange={(e) => {
          const { files } = e.target;
          if (files) handleFileChange(files);
        }}
        hidden
      />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;
