import {
  createStyles,
  CSSObject,
  Group,
  Input,
  InputWrapperProps,
  MantineSize,
  Text,
} from '@mantine/core';
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
import { containerQuery } from '~/utils/mantine-css-helpers';
import { getRandomId, validateThirdPartyUrl } from '~/utils/string-helpers';
import { InsertImageControl } from './InsertImageControl';
import { InsertYoutubeVideoControl } from './InsertYoutubeVideoControl';
import { getSuggestions } from './suggestion';

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

const useStyles = createStyles((theme) => ({
  mention: {
    color: theme.colors.blue[4],
  },
  instagramEmbed: {
    aspectRatio: '9/16',
    maxHeight: 1060,
    maxWidth: '50%',
    overflow: 'hidden',

    [containerQuery.smallerThan('sm')]: {
      maxWidth: '100%',
    },
  },
  strawPollEmbed: {
    aspectRatio: '4/3',
    maxHeight: 480,
    // Ignoring because we want to use !important, if not then it complaints about it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pointerEvents: 'auto !important' as any,
  },
  bubbleTooltip: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white,
  },
}));

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
  ...props
}: Props) {
  const { classes } = useStyles();
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
    }),
    ...(addHeading
      ? [
          Heading.configure({
            levels: [1, 2, 3],
          }).extend({
            addAttributes() {
              return {
                ...this.parent?.(),
                id: { default: null },
              };
            },
            addOptions() {
              return {
                ...this.parent?.(),
                HTMLAttributes: {
                  id: null,
                },
              };
            },
            renderHTML({ node }) {
              const hasLevel = this.options.levels.includes(node.attrs.level);
              const level = hasLevel ? node.attrs.level : this.options.levels[0];
              const id = `${slugify(node.textContent.toLowerCase())}-${getRandomId()}`;

              return [`h${level}`, mergeAttributes(this.options.HTMLAttributes, { id }), 0];
            },
          }),
        ]
      : []),
    ...(onSuperEnter
      ? [
          Extension.create({
            name: 'onSubmitShortcut',
            addKeyboardShortcuts: () => ({
              'Mod-Enter': () => {
                onSuperEnter();
                return true; // Dunno why they want a boolean here
              },
            }),
          }),
        ]
      : []),
    ...(addFormatting ? [Underline] : []),
    ...(addColors ? [TextStyle, Color] : []),
    ...(addLink ? [linkExtension] : []),
    ...(addMedia
      ? [
          CustomImage.configure({
            // To allow links on images
            inline: true,
            uploadImage: uploadToCF,
            onUploadStart: () => {
              showNotification({
                id: UPLOAD_NOTIFICATION_ID,
                loading: true,
                disallowClose: true,
                autoClose: false,
                message: 'Uploading images...',
              });
            },
            onUploadEnd: () => {
              hideNotification(UPLOAD_NOTIFICATION_ID);
            },
          }),
          Youtube.configure({
            addPasteHandler: false,
            modestBranding: false,
          }).extend({
            addPasteRules() {
              return [
                nodePasteRule({
                  find: /^(https?:\/\/)?(www\.|music\.)?(youtube\.com|youtu\.be)(?!.*\/channel\/)(?!\/@)(.+)?$/g,
                  type: this.type,
                  getAttributes: (match) => ({ src: match.input }),
                }),
              ];
            },
          }),
          Instagram.configure({
            HTMLAttributes: { class: classes.instagramEmbed },
            height: 'auto',
          }),
        ]
      : []),
    ...(addMentions
      ? [
          Mention.configure({
            suggestion: getSuggestions({ defaultSuggestions }),
            HTMLAttributes: {
              class: classes.mention,
            },
            renderLabel({ options, node }) {
              return `${options.suggestion.char}${node.attrs.label ?? node.attrs.id}`;
            },
          }),
        ]
      : []),
    ...(addPolls
      ? [
          StrawPoll.configure({
            HTMLAttributes: { class: classes.strawPollEmbed },
            height: 'auto',
          }),
        ]
      : []),
  ];

  const editor = useEditor({
    extensions,
    content: value,
    onUpdate: onChange ? ({ editor }) => onChange(editor.getHTML()) : undefined,
    editable: !disabled,
  });

  const editorRef = useRef<Editor>();

  // To clear content after a form submission
  useEffect(() => {
    if (!value && editor) editor.commands.clearContent();
  }, [editor, value]);

  useEffect(() => {
    if (reset > 0 && editor && value && editor.getHTML() !== value) {
      editor.commands.setContent(value);
    }
  }, [reset]); //eslint-disable-line

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus('end', { scrollIntoView: true });
  }, [editor, autoFocus]);

  useEffect(() => {
    if (editor && !editorRef.current) editorRef.current = editor;
  }, [editor]);

  // Used to call editor commands outside the component via a ref
  useImperativeHandle(innerRef, () => ({
    insertContentAtCursor: (value) => {
      if (editorRef.current && innerRef) {
        const currentPosition = editorRef.current.state.selection.$anchor.pos;
        editorRef.current.commands.insertContentAt(currentPosition, value);
      }
    },
    focus: () => {
      if (editorRef.current && innerRef) {
        editorRef.current.commands.focus('end');
      }
    },
  }));

  return (
    <Input.Wrapper
      id={id}
      label={label}
      labelProps={labelProps}
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
            ...mapEditorSize[editorSize],
            // minHeight: mapEditorSizeHeight[editorSize],

            '& p.is-editor-empty:first-of-type::before': {
              color: error ? theme.colors.red[8] : undefined,
              fontSize: 14,
            },
          },

          '& iframe': {
            pointerEvents: 'none',
          },
        })}
      >
        {!hideToolbar && (
          <RTE.Toolbar sticky={stickyToolbar} stickyOffset={toolbarOffset}>
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
                <RTE.CodeBlock />
                {addColors && (
                  <RTE.ColorPicker colors={[...constants.richTextEditor.presetColors]} />
                )}
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
                <InsertInstagramEmbedControl />
              </RTE.ControlsGroup>
            )}
            {addPolls && (
              <RTE.ControlsGroup>
                <InsertStrawPollControl />
              </RTE.ControlsGroup>
            )}
          </RTE.Toolbar>
        )}

        {editor && (
          // Don't show the bubble menu for images, to prevent setting images as headings, etc.
          <BubbleMenu
            editor={editor}
            shouldShow={({ editor }) => !editor.state.selection.empty && !editor.isActive('image')}
            className={classes.bubbleTooltip}
          >
            <RTE.ControlsGroup>
              {addHeading ? (
                <>
                  <RTE.H1 />
                  <RTE.H2 />
                  <RTE.H3 />
                </>
              ) : null}
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
  };
