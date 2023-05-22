import { mergeAttributes, Node, nodePasteRule } from '@tiptap/core';

type StrawPollOptions = {
  addPasteHandler: boolean;
  HTMLAttributes: MixedObject;
  width: string | number;
  height: string | number;
};
type SetStrawPollEmbedOptions = { src: string; width?: string | number; height?: string | number };

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    strawPoll: {
      setStrawPollEmbed: (options: SetStrawPollEmbedOptions) => ReturnType;
    };
  }
}

export const STRAWPOLL_REGEX =
  /(?:https?:\/\/)?(?:www\.)?strawpoll\.com\/(?:polls|embed)\/([a-zA-Z0-9_-]+)\/?/;
const isValidStrawPollUrl = (url: string) => {
  return STRAWPOLL_REGEX.test(url);
};
const getEmbedUrlFromStrawPollUrl = (url: string) => {
  if (url.includes('/embed')) {
    return url;
  }

  const matches = STRAWPOLL_REGEX.exec(url);
  if (!matches || !matches[1]) {
    return null;
  }

  return `https://www.strawpoll.com/embed/${matches[1]}`;
};

export const StrawPoll = Node.create<StrawPollOptions>({
  name: 'strawPoll',
  draggable: true,

  inline: false,
  group: 'block',

  addOptions() {
    return {
      ...this.parent?.(),
      addPasteHandler: true,
      HTMLAttributes: {},
      width: '100%',
      height: 450,
    };
  },

  addAttributes() {
    return {
      src: { default: null },
      width: { default: this.options.width },
      height: { default: this.options.height },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[data-type="${this.name}"] iframe`,
      },
    ];
  },

  addCommands() {
    return {
      setStrawPollEmbed:
        (options: SetStrawPollEmbedOptions) =>
        ({ commands }) => {
          if (!isValidStrawPollUrl(options.src)) return false;

          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  addPasteRules() {
    if (!this.options.addPasteHandler) {
      return [];
    }

    return [
      nodePasteRule({
        find: new RegExp(STRAWPOLL_REGEX, 'g'),
        type: this.type,
        getAttributes: (match) => {
          return { src: match.input ? getEmbedUrlFromStrawPollUrl(match.input) : null };
        },
      }),
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const embedUrl = getEmbedUrlFromStrawPollUrl(HTMLAttributes.src ?? '');

    return [
      'div',
      { 'data-type': this.name },
      [
        'iframe',
        mergeAttributes(this.options.HTMLAttributes, {
          width: this.options.width,
          height: this.options.height,
          src: embedUrl,
        }),
      ],
    ];
  },
});
