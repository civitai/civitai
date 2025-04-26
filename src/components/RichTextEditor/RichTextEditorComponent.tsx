import { CSSObject, Group, Input, InputWrapperProps, MantineSize, Text } from '@mantine/core';
import { openModal } from '@mantine/modals';
import { hideNotification, showNotification } from '@mantine/notifications';
import { Link, RichTextEditor as RTE, RichTextEditorProps } from '@mantine/tiptap';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Color } from '@tiptap/extension-color';
import Heading from '@tiptap/extension-heading';
import Mention from '@tiptap/extension-mention';
import Placeholder from '@tiptap/extension-placeholder';
import TextStyle from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import Youtube from '@tiptap/extension-youtube';
import {
  BubbleMenu,
  Editor,
  Extension,
  Extensions,
  mergeAttributes,
  nodePasteRule,
  useEditor,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useImperativeHandle, useRef } from 'react';
import slugify from 'slugify';
import { InsertInstagramEmbedControl } from '~/components/RichTextEditor/InsertInstagramEmbedControl';
import { InsertStrawPollControl } from '~/components/RichTextEditor/InsertStrawPollControl';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { CustomImage } from '~/libs/tiptap/extensions/CustomImage';
import { Instagram } from '~/libs/tiptap/extensions/Instagram';
import { StrawPoll } from '~/libs/tiptap/extensions/StrawPoll';
import { constants } from '~/server/common/constants';
import { getRandomId, validateThirdPartyUrl } from '~/utils/string-helpers';
import { InsertImageControl } from './InsertImageControl';
import { InsertYoutubeVideoControl } from './InsertYoutubeVideoControl';
import { getSuggestions } from './suggestion';
import styles from './RichTextEditorComponent.module.scss';

// const mapEditorSizeHeight: Omit<Record<MantineSize, string>, 'xs'> = {
//   sm: '30px',
//   md: '50px',
//   lg: '70px',
//   xl: '90px',
// };

const mapEditorSize: Omit<Record<MantineSize, CSSObject>, 'xs'> = {
  sm: {
    minHeight: 30,
    fontSize: 14,
  },
  md: {
    minHeight: 50,
  },
  lg: {
    minHeight: 70,
  },
  xl: {
    minHeight: 90,
  },
};

function openLinkWhitelistRequestModal() {
  return openModal({
    title: (
      <Group spacing="xs">
        <IconAlertTriangle color="gold" />
        <Text size="lg">Blocked URL</Text>
      </Group>
    ),
    children: (
      <Text>
        The URL you entered is not allowed. You can submit a request to add it to the whitelist.
        Please follow{' '}
        <Text
          component="a"
          variant="link"
          href="https://forms.gle/MzMCVA4mq3r4osv6A"
          target="_blank"
          rel="nofollow noreferrer"
        >
          this link
        </Text>{' '}
        to do so.
      </Text>
    ),
  });
}

const LinkWithValidation = Link.extend({
  onUpdate() {
    const url = this.editor.getAttributes('link')?.href;

    if (url) {
      const valid = validateThirdPartyUrl(url);
      if (!valid) {
        this.editor.chain().focus().extendMarkRange('link').unsetLink().run();
        openLinkWhitelistRequestModal();
      }
    }
  },
}).configure({
  validate: (url) => {
    const valid = validateThirdPartyUrl(url);
    if (!valid) openLinkWhitelistRequestModal();

    return valid;
  },
});

const UPLOAD_NOTIFICATION_ID = 'upload-image-notification';

export function RichTextEditor({
  id,
  label,
  labelProps,
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
  reset = 0,
  autoFocus,
  defaultSuggestions,
  innerRef,
  onSuperEnter,
  withLinkValidation,
  stickyToolbar,
  toolbarOffset = 70,
  inputClasses,
  ...props
}: Props) {
  const addHeading = includeControls.includes('heading');
  const addFormatting = includeControls.includes('formatting');
  const addColors = addFormatting && includeControls.includes('colors');
  const addList = includeControls.includes('list');
  const addLink = includeControls.includes('link');
  const addMedia = includeControls.includes('media');
  const addMentions = includeControls.includes('mentions');
  const addPolls = includeControls.includes('polls');

  const linkExtension = withLinkValidation ? LinkWithValidation : Link;

  const { uploadToCF } = useCFImageUpload();

  const extensions: Extensions = [
    Placeholder.configure({ placeholder }),
    StarterKit.configure({
      // heading: !addHeading ? false : { levels: [1, 2, 3] },
      heading: false,
      bulletList: !addList ? false : undefined,
      orderedList: !addList ? false : undefined,
      bold: !addFormatting ? false : undefined,
      italic: !addFormatting ? false : undefined,
      strike: !addFormatting ? false : undefined,
      code: !addFormatting ? false : undefined,
      blockquote: !addFormatting ? false : undefined,
      codeBlock: !addFormatting ? false : undefined,
      dropcursor: !addMedia ? false : undefined,
    }),
    ...(addHeading
      ? [
          Heading.configure({
            levels: [1, 2, 3],
            HTMLAttributes: {
              class: 'mantine-Text-root mantine-Title-root',
            },
          }),
        ]
      : []),
    ...(addFormatting ? [Underline] : []),
    ...(addColors ? [Color, TextStyle] : []),
    ...(addLink
      ? [
          linkExtension.configure({
            openOnClick: false,
            HTMLAttributes: {
              class: 'mantine-Anchor-root',
            },
          }),
        ]
      : []),
    ...(addMedia
      ? [
          CustomImage.configure({
            HTMLAttributes: {
              class: 'mantine-Image-root',
            },
          }),
          Youtube.configure({
            HTMLAttributes: {
              class: 'mantine-Image-root',
            },
          }),
        ]
      : []),
    ...(addMentions
      ? [
          Mention.configure({
            HTMLAttributes: {
              class: styles.mention,
            },
            suggestion: {
              items: ({ query }) => getSuggestions({ query, defaultSuggestions }),
              render: () => {
                return {
                  onStart: (props) => {
                    showNotification({
                      id: UPLOAD_NOTIFICATION_ID,
                      title: 'Loading suggestions...',
                      message: 'Please wait while we load suggestions',
                      loading: true,
                      autoClose: false,
                    });
                  },
                  onUpdate: (props) => {
                    if (props.items.length === 0) {
                      showNotification({
                        id: UPLOAD_NOTIFICATION_ID,
                        title: 'No suggestions found',
                        message: 'Try a different search term',
                        color: 'yellow',
                      });
                    } else {
                      hideNotification(UPLOAD_NOTIFICATION_ID);
                    }
                  },
                  onKeyDown: (props) => {
                    if (props.event.key === 'Escape') {
                      props.event.preventDefault();
                      props.event.stopPropagation();
                      return true;
                    }
                    return false;
                  },
                };
              },
            },
          }),
        ]
      : []),
    ...(addPolls
      ? [
          StrawPoll.configure({
            HTMLAttributes: {
              class: styles.strawPollEmbed,
            },
          }),
        ]
      : []),
  ];

  const editor = useEditor({
    extensions,
    content: value ?? '',
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML());
    },
    editable: !disabled,
    autofocus: autoFocus,
  });

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value ?? '');
    }
  }, [editor, value, reset]);

  useImperativeHandle(
    innerRef,
    () => ({
      insertContentAtCursor: (value: string) => {
        editor?.commands.insertContent(value);
      },
      focus: () => {
        editor?.commands.focus();
      },
    }),
    [editor]
  );

  return (
    <Input.Wrapper
      id={id}
      label={label}
      labelProps={labelProps}
      description={description}
      withAsterisk={withAsterisk}
      error={error}
      classNames={inputClasses ? { root: inputClasses } : undefined}
    >
      <RTE
        editor={editor}
        {...props}
        sx={[
          mapEditorSize[editorSize],
          {
            '& .ProseMirror': {
              minHeight: mapEditorSize[editorSize].minHeight,
            },
          },
        ]}
      >
        {!hideToolbar && (
          <RTE.Toolbar sticky={stickyToolbar} stickyOffset={toolbarOffset}>
            <RTE.ControlsGroup>
              {addHeading && (
                <>
                  <RTE.H1 />
                  <RTE.H2 />
                  <RTE.H3 />
                </>
              )}
              {addFormatting && (
                <>
                  <RTE.Bold />
                  <RTE.Italic />
                  <RTE.Underline />
                  <RTE.Strikethrough />
                  <RTE.ClearFormatting />
                </>
              )}
              {addColors && (
                <>
                  <RTE.ColorPicker colors={constants.richTextEditor.presetColors} />
                  <RTE.Highlight />
                </>
              )}
            </RTE.ControlsGroup>

            <RTE.ControlsGroup>
              {addList && (
                <>
                  <RTE.BulletList />
                  <RTE.OrderedList />
                </>
              )}
              {addFormatting && (
                <>
                  <RTE.Blockquote />
                  <RTE.CodeBlock />
                </>
              )}
            </RTE.ControlsGroup>

            <RTE.ControlsGroup>
              {addLink && <RTE.Link />}
              {addMedia && (
                <>
                  <InsertImageControl />
                  <InsertYoutubeVideoControl />
                  <InsertInstagramEmbedControl />
                </>
              )}
              {addPolls && <InsertStrawPollControl />}
            </RTE.ControlsGroup>
          </RTE.Toolbar>
        )}

        <RTE.Content />

        {addMentions && editor && (
          <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }} style={styles.bubbleTooltip}>
            <RTE.ControlsGroup>
              <RTE.Link />
              <RTE.Bold />
              <RTE.Italic />
            </RTE.ControlsGroup>
          </BubbleMenu>
        )}
      </RTE>
    </Input.Wrapper>
  );
}

export type EditorCommandsRef = {
  insertContentAtCursor: (value: string) => void;
  focus: () => void;
};

type ControlType =
  | 'heading'
  | 'formatting'
  | 'list'
  | 'link'
  | 'media'
  | 'mentions'
  | 'polls'
  | 'colors';
type Props = Omit<RichTextEditorProps, 'editor' | 'children' | 'onChange'> &
  Pick<InputWrapperProps, 'label' | 'labelProps' | 'description' | 'withAsterisk' | 'error'> & {
    value?: string;
    includeControls?: ControlType[];
    onChange?: (value: string) => void;
    disabled?: boolean;
    hideToolbar?: boolean;
    editorSize?: 'sm' | 'md' | 'lg' | 'xl';
    reset?: number;
    autoFocus?: boolean;
    defaultSuggestions?: Array<{ id: number; label: string }>;
    innerRef?: React.ForwardedRef<EditorCommandsRef>;
    onSuperEnter?: () => void;
    withLinkValidation?: boolean;
    stickyToolbar?: boolean;
    toolbarOffset?: number;
    inputClasses?: string;
  };
