import {
  RichTextEditor,
  RichTextEditorControlProps,
  useRichTextEditorContext,
} from '@mantine/tiptap';
import { IconPhoto } from '@tabler/icons-react';
import { useRef } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';

export function InsertImageControl(props: Props) {
  const { editor } = useRichTextEditorContext();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { uploadToCF } = useCFImageUpload();

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = async (fileList: FileList) => {
    const files = Array.from(fileList);
    const images = await Promise.all(files.map((file) => uploadToCF(file))).catch((error) => {
      console.error(error);
      window.alert(`Failed to upload image. ${error.message}`);
      return [];
    });

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
        accept={constants.richTextEditor.accept.join(',')}
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
