import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconPhoto } from '@tabler/icons-react';
import { useRef } from 'react';
import { constants } from '~/server/common/constants';
import { MEDIA_TYPE } from '~/shared/constants/mime-types';

export function InsertImageControl(props: Props) {
  const { editor } = useRichTextEditorContext();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = async (fileList: FileList) => {
    if (!editor) return;
    console.log({ editor });

    for (const file of Array.from(fileList)) {
      // const schema = editor.schema;
      // const media = schema.nodes.media.create({
      //   url: URL.createObjectURL(file),
      //   type: MEDIA_TYPE[file.type],
      //   filename: file.name,
      // });
      // console.log({ media });
      // const transaction = editor.view.state.tr.replaceSelectionWith(media);
      // editor.view.dispatch(transaction);
      editor.commands.addMedia(file);
      // editor?.commands.setMedia({
      //   url: URL.createObjectURL(file),
      //   type: MEDIA_TYPE[file.type],
      //   filename: file.name,
      // });
    }

    // const images = await Promise.all(files.map((file) => uploadToCF(file))).catch(
    //   (error: Error) => {
    //     console.error(error);
    //     window.alert(`Failed to upload image. ${error.message}`);
    //     return [];
    //   }
    // );

    // if (images.length > 0)
    //   images.map((image) => editor?.commands.setMedia({ url: image.id, type: image.type }));
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
