import type { Options } from 'react-markdown';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { formatChatSystemMessage } from '~/shared/utils/chat';

/**
 * A path on this site. Never "//host" or "/\host", which a browser opens elsewhere, nor an encoded
 * slash, backslash or control character, or whitespace, that could be read as one.
 */
const isSameSitePath = (href: unknown): href is string =>
  typeof href === 'string' &&
  /^\/[^/\\]/.test(href) &&
  !/%2f|%5c|%[01][0-9a-f]|%7f|\\|[\s\x00-\x1f]/i.test(href);

// Server-written notes link to our own pages ("Open the deal"). Any other link, such as one in a
// group name, renders as its text.
const allowElement: Options['allowElement'] = (element) =>
  element.tagName !== 'a' || isSameSitePath(element.properties?.href);

/** A system note's text ("Group renamed to …", "Deal accepted: …"). */
export function ChatSystemNoteText({
  content,
  username,
}: {
  content: string;
  username?: string | null;
}) {
  return (
    <CustomMarkdown
      allowedElements={['a', 'p', 'strong']}
      allowElement={allowElement}
      unwrapDisallowed
    >
      {formatChatSystemMessage({ content, username })}
    </CustomMarkdown>
  );
}
