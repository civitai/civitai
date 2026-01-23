import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconPhoto } from '@tabler/icons-react';
import { useRef } from 'react';
import { getMimeTypesFromMediaTypes } from '~/shared/constants/mime-types';
import type { MediaType } from '~/shared/utils/prisma/enums';

export function InsertImageControl({ accepts = ['image'], ...props }: Props) {
  const { editor } = useRichTextEditorContext();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = async (fileList: FileList) => {
    if (!editor) return;

    for (const file of Array.from(fileList)) {
      editor.commands.addMedia(file);
    }
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
        accept={getMimeTypesFromMediaTypes(accepts).join(',')}
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

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'> & { accepts?: MediaType[] };
