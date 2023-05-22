import { mergeAttributes, Node, nodePasteRule } from '@tiptap/core';

type InstagramOptions = {
  addPasteHandler: boolean;
  HTMLAttributes: MixedObject;
  width: string | number;
  height: string | number;
};
type SetInstagramEmbedOptions = { src: string; width?: string | number; height?: string | number };

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    instagram: {
      setInstagramEmbed: (options: SetInstagramEmbedOptions) => ReturnType;
    };
  }
}

export const INSTAGRAM_REGEX =
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(p|reel)\/([a-zA-Z0-9_-]+)\/?/;
const isValidInstagramUrl = (url: string) => {
  return INSTAGRAM_REGEX.test(url);
};
const getEmbedUrlFromInstagramUrl = (url: string) => {
  if (url.includes('/embed')) {
    return url;
  }

  const matches = INSTAGRAM_REGEX.exec(url);
  if (!matches || !matches[1] || !matches[2]) {
    return null;
  }

  return `https://www.instagram.com/${matches[1]}/${matches[2]}/embed`;
};

export const Instagram = Node.create<InstagramOptions>({
  name: 'instagram',
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
      setInstagramEmbed:
        (options: SetInstagramEmbedOptions) =>
        ({ commands }) => {
          if (!isValidInstagramUrl(options.src)) return false;

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
        find: new RegExp(INSTAGRAM_REGEX, 'g'),
        type: this.type,
        getAttributes: (match) => {
          return { src: match.input ? getEmbedUrlFromInstagramUrl(match.input) : null };
        },
      }),
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const embedUrl = getEmbedUrlFromInstagramUrl(HTMLAttributes.src ?? '');

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
