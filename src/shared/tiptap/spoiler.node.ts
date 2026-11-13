import { Mark, Node, markInputRule, markPasteRule, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    spoiler: { toggleSpoiler: () => ReturnType };
    spoilerBlock: { toggleSpoilerBlock: () => ReturnType };
  }
}

// Discord's `||text||`. The trailing group is the text the mark covers, which is what
// markInputRule/markPasteRule expect.
const SPOILER_INPUT = /(?:^|\s)(\|\|(?!\s)([^|]+?)(?<!\s)\|\|)$/;
const SPOILER_PASTE = /(?:^|\s)(\|\|(?!\s)([^|]+?)(?<!\s)\|\|)/g;

// Both shapes are already in the default sanitize allowlist (`span`/`div` with `data-type`), so
// the stored markup needs no new tag or attribute.
export const SpoilerMark = Mark.create({
  name: 'spoiler',
  // Outermost, so a spoiler holding bold or a link serialises as one span around them.
  priority: 1100,

  parseHTML() {
    return [{ tag: 'span[data-type="spoiler"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': 'spoiler' }, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      toggleSpoiler:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },

  addInputRules() {
    return [markInputRule({ find: SPOILER_INPUT, type: this.type })];
  },

  addPasteRules() {
    return [markPasteRule({ find: SPOILER_PASTE, type: this.type })];
  },
});

// Wraps whole blocks, so it covers an image, a video, an embed or a poll alike.
export const SpoilerBlockNode = Node.create({
  name: 'spoilerBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="spoiler"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'spoiler' }, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      toggleSpoilerBlock:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
    };
  },
});
