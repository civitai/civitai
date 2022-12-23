import { Input, InputWrapperProps, MantineSize } from '@mantine/core';
import { Link, RichTextEditor as RTE, RichTextEditorProps } from '@mantine/tiptap';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import Youtube from '@tiptap/extension-youtube';
import { BubbleMenu, Extensions, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';

import { InsertImageControl } from './InsertImageControl';
import { InsertYoutubeVideoControl } from './InsertYoutubeVideoControl';

const mapEditorSizeHeight: Omit<Record<MantineSize, string>, 'xs'> = {
  sm: '30px',
  md: '50px',
  lg: '70px',
  xl: '90px',
};

export function RichTextEditor({
  id,
  label,
  description,
  withAsterisk,
  error,
  placeholder,
  value,
  onChange,
  includeControls = ['formatting'],
  disabled = false,
  hideToolbar = false,
  editorSize = 'sm',
  ...props
}: Props) {
  const addHeading = includeControls.includes('heading');
  const addFormatting = includeControls.includes('formatting');
  const addList = includeControls.includes('list');
  const addLink = includeControls.includes('link');
  const addMedia = includeControls.includes('media');

  const extensions: Extensions = [
    Placeholder.configure({ placeholder }),
    StarterKit.configure({
      heading: !addHeading ? false : undefined,
      bulletList: !addList ? false : undefined,
      orderedList: !addList ? false : undefined,
      bold: !addFormatting ? false : undefined,
      italic: !addFormatting ? false : undefined,
      strike: !addFormatting ? false : undefined,
      code: !addFormatting ? false : undefined,
      blockquote: !addFormatting ? false : undefined,
      codeBlock: !addFormatting ? false : undefined,
    }),
    ...(addFormatting ? [Underline] : []),
    ...(addLink ? [Link] : []),
    // Casting width as any to be able to use `100%`
    // since the tiptap extension API doesn't allow
    // strings for its value
    ...(addMedia ? [Image, Youtube.configure({ width: '100%' as any })] : []),
  ];

  const editor = useEditor({
    extensions,
    content: value,
    onUpdate: onChange ? ({ editor }) => onChange(editor.getHTML()) : undefined,
    editable: !disabled,
  });

  // To clear content after a form submission
  useEffect(() => {
    if (!value && editor) editor.commands.clearContent();
  }, [editor, value]);

  return (
    <Input.Wrapper
      id={id}
      label={label}
      description={description}
      withAsterisk={withAsterisk}
      error={error}
    >
      <RTE
        {...props}
        editor={editor}
        id={id}
        sx={(theme) => ({
          marginTop: description ? 5 : undefined,
          marginBottom: error ? 5 : undefined,
          borderColor: error ? theme.colors.red[8] : undefined,

          // Fixes gapcursor color for dark mode
          '& .ProseMirror-gapcursor:after': {
            borderTop: `1px solid ${theme.colorScheme === 'dark' ? 'white' : 'black'}`,
          },

          '& .ProseMirror': {
            minHeight: mapEditorSizeHeight[editorSize],

            '& p.is-editor-empty:first-of-type::before': {
              color: error ? theme.colors.red[8] : undefined,
            },
          },
        })}
      >
        {!hideToolbar && (
          <RTE.Toolbar>
            {addHeading && (
              <RTE.ControlsGroup>
                <RTE.H1 />
                <RTE.H2 />
                <RTE.H3 />
              </RTE.ControlsGroup>
            )}

            {addFormatting && (
              <RTE.ControlsGroup>
                <RTE.Bold />
                <RTE.Italic />
                <RTE.Underline />
                <RTE.Strikethrough />
                <RTE.ClearFormatting />
              </RTE.ControlsGroup>
            )}

            {addList && (
              <RTE.ControlsGroup>
                <RTE.BulletList />
                <RTE.OrderedList />
              </RTE.ControlsGroup>
            )}

            {addLink && (
              <RTE.ControlsGroup>
                <RTE.Link />
                <RTE.Unlink />
              </RTE.ControlsGroup>
            )}

            {addMedia && (
              <RTE.ControlsGroup>
                <InsertImageControl />
                <InsertYoutubeVideoControl />
              </RTE.ControlsGroup>
            )}
          </RTE.Toolbar>
        )}

        {editor && (
          <BubbleMenu editor={editor}>
            <RTE.ControlsGroup>
              {addFormatting ? (
                <>
                  <RTE.Bold />
                  <RTE.Italic />
                </>
              ) : null}
              {addList ? <RTE.BulletList /> : null}
              {addLink ? <RTE.Link /> : null}
            </RTE.ControlsGroup>
          </BubbleMenu>
        )}

        <RTE.Content />
      </RTE>
    </Input.Wrapper>
  );
}

type ControlType = 'heading' | 'formatting' | 'list' | 'link' | 'media';

type Props = Omit<RichTextEditorProps, 'editor' | 'children' | 'onChange'> &
  Pick<InputWrapperProps, 'label' | 'description' | 'withAsterisk' | 'error'> & {
    value?: string;
    includeControls?: ControlType[];
    onChange?: (value: string) => void;
    disabled?: boolean;
    hideToolbar?: boolean;
    editorSize?: 'sm' | 'md' | 'lg' | 'xl';
  };
