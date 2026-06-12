import {
  DISCORD_TIMESTAMP_REGEX,
  formatDiscordTimestamp,
  normalizeTimestampStyle,
  unixSecondsToISO,
} from '~/utils/timestamp-helpers';

/**
 * remark plugin that turns Discord-style `<t:UNIX:STYLE>` tags into a custom
 * mdast node which remark-rehype emits as a `<time data-type="timestamp">`
 * element. The element carries the raw unix/style values as data attributes so
 * the React `time` component override (and the RenderHtml hydrator) can render
 * the viewer's local time. A UTC fallback string is kept as the child text so
 * non-component consumers still show a readable date.
 *
 * `<t:...>` is not valid inline HTML or an autolink in CommonMark, so remark
 * leaves it inside text nodes for us to split here.
 */
export function remarkTimestamp() {
  return (tree: any) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'text' || !parent || typeof index !== 'number') return;
      const value: string = node.value ?? '';
      if (!value.includes('<t:')) return;

      const regex = new RegExp(DISCORD_TIMESTAMP_REGEX.source, 'g');
      const replacements: any[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(value)) !== null) {
        const [raw, secondsRaw, styleRaw] = match;
        const seconds = parseInt(secondsRaw, 10);
        if (!Number.isFinite(seconds)) continue;

        if (match.index > lastIndex) {
          replacements.push({ type: 'text', value: value.slice(lastIndex, match.index) });
        }

        const style = normalizeTimestampStyle(styleRaw);
        const fallback = formatDiscordTimestamp(seconds, style, { utc: true });

        replacements.push({
          type: 'timestamp',
          data: {
            hName: 'time',
            hProperties: {
              dataType: 'timestamp',
              dataValue: String(seconds),
              dataStyle: style,
              dateTime: unixSecondsToISO(seconds),
            },
            hChildren: [{ type: 'text', value: fallback }],
          },
        });

        lastIndex = match.index + raw.length;
      }

      if (!replacements.length) return;
      if (lastIndex < value.length) {
        replacements.push({ type: 'text', value: value.slice(lastIndex) });
      }

      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}

/** Minimal mdast walker (avoids adding a unist-util-visit dependency). */
function visit(
  node: any,
  visitor: (node: any, index: number | null, parent: any | null) => number | void,
  index: number | null = null,
  parent: any | null = null
): number | void {
  const result = visitor(node, index, parent);
  // When the visitor splices replacements in, it returns the next index to
  // resume from so we don't re-scan freshly inserted nodes.
  if (typeof result === 'number') return result;
  const children = node?.children;
  if (Array.isArray(children)) {
    let i = 0;
    while (i < children.length) {
      const next = visit(children[i], visitor, i, node);
      i = typeof next === 'number' ? next : i + 1;
    }
  }
}
