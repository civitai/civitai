import { InputRule, mergeAttributes, Node, nodePasteRule } from '@tiptap/core';
import {
  DEFAULT_TIMESTAMP_STYLE,
  formatDiscordTimestamp,
  normalizeTimestampStyle,
  unixSecondsToISO,
} from '~/utils/timestamp-helpers';

export interface TimestampAttributes {
  value: string;
  style: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    timestamp: {
      /** Insert a Discord-style local timestamp at the current selection. */
      setTimestamp: (attributes: { value: number | string; style?: string }) => ReturnType;
    };
  }
}

// Anchored variant for input rules (fires as the closing `>` is typed) and a
// global variant for paste rules.
const inputRegex = /<t:(-?\d{1,12})(?::([tTdDfFR]))?>$/;
const pasteRegex = /<t:(-?\d{1,12})(?::([tTdDfFR]))?>/g;

/**
 * Tiptap node for Discord-style `<t:UNIX:STYLE>` timestamps. It serializes to a
 * `<time data-type="timestamp">` element so it round-trips through stored HTML
 * and the sanitizer, and renders in the viewer's local time (via the React
 * node view in the editor, the static-renderer node mapping when viewing
 * articles, or the RenderHtml hydrator for raw-HTML surfaces).
 */
export const TimestampNode = Node.create({
  name: 'timestamp',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      value: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-value'),
        renderHTML: (attributes) => ({ 'data-value': attributes.value }),
      },
      style: {
        default: DEFAULT_TIMESTAMP_STYLE,
        parseHTML: (element) => normalizeTimestampStyle(element.getAttribute('data-style')),
        renderHTML: (attributes) => ({ 'data-style': normalizeTimestampStyle(attributes.style) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'time[data-type="timestamp"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const seconds = parseInt(node.attrs.value, 10);
    const style = normalizeTimestampStyle(node.attrs.style);
    const fallback = Number.isFinite(seconds)
      ? formatDiscordTimestamp(seconds, style, { utc: true })
      : '';
    const dateTime = unixSecondsToISO(seconds);
    return [
      'time',
      mergeAttributes(HTMLAttributes, { 'data-type': 'timestamp', datetime: dateTime }),
      fallback,
    ];
  },

  renderText({ node }) {
    const style = normalizeTimestampStyle(node.attrs.style);
    return `<t:${node.attrs.value}:${style}>`;
  },

  addCommands() {
    return {
      setTimestamp:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              value: String(attributes.value),
              style: normalizeTimestampStyle(attributes.style),
            },
          }),
    };
  },

  addInputRules() {
    // NB: tiptap's `nodeInputRule` offsets the replacement to the first capture
    // group, so it would only swap the digits and leave the surrounding `<t:`
    // and `:t>` behind. Use a plain InputRule that replaces the whole match.
    const type = this.type;
    return [
      new InputRule({
        find: inputRegex,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(
            range.from,
            range.to,
            type.create({ value: match[1], style: normalizeTimestampStyle(match[2]) })
          );
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: pasteRegex,
        type: this.type,
        getAttributes: (match) => ({
          value: match[1],
          style: normalizeTimestampStyle(match[2]),
        }),
      }),
    ];
  },
});
