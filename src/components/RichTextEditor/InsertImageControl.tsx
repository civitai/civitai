import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconPhoto } from '@tabler/icons-react';
import { useRef } from 'react';
import { getMimeTypesFromMediaTypes } from '~/shared/constants/mime-types';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { formatBytes } from '~/utils/number-helpers';
import { showWarningNotification } from '~/utils/notifications';

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'> & {
  accepts?: MediaType[];
  maxFileSize?: number;
};

export function InsertImageControl({ accepts = ['image'], maxFileSize, ...props }: Props) {
  const { editor } = useRichTextEditorContext();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const acceptedMimeTypes = getMimeTypesFromMediaTypes(accepts);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = (fileList: FileList) => {
    if (!editor) return;

    for (const file of Array.from(fileList)) {
      if (!acceptedMimeTypes.includes(file.type)) {
        showWarningNotification({
          message: `Unsupported file type. Supported types: ${accepts.join(', ')}`,
        });
        continue;
      }
      if (maxFileSize && file.size > maxFileSize) {
        showWarningNotification({
          message: `File is too big. Max file size is ${formatBytes(maxFileSize)}`,
        });
        continue;
      }
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
        accept={acceptedMimeTypes.join(',')}
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

export function InsertImageControlLegacy({ accepts = ['image'], maxFileSize, ...props }: Props) {
  const { editor } = useRichTextEditorContext();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const acceptedMimeTypes = getMimeTypesFromMediaTypes(accepts);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = (fileList: FileList) => {
    for (const file of Array.from(fileList)) {
      if (!acceptedMimeTypes.includes(file.type)) {
        showWarningNotification({
          message: `Unsupported file type. Supported types: ${accepts.join(', ')}`,
        });
        continue;
      }
      if (maxFileSize && file.size > maxFileSize) {
        showWarningNotification({
          message: `File is too big. Max file size is ${formatBytes(maxFileSize)}`,
        });
        continue;
      }
      editor?.commands.insertContent({
        type: 'image',
        attrs: { src: URL.createObjectURL(file), filename: file.name },
      });
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
        accept={acceptedMimeTypes.join(',')}
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
