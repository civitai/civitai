import { safeReturnPath } from '@civitai/auth/client';
import type { Options } from 'react-markdown';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { formatChatSystemMessage } from '~/shared/utils/chat';

/**
 * A path on this site, by the shared same-origin rule. Encoded slashes, backslashes and control
 * characters are refused too: no note the server writes needs one.
 */
const isSameSitePath = (href: unknown): href is string =>
  safeReturnPath(href) !== null && !/%2f|%5c|%[01][0-9a-f]|%7f/i.test(href as string);

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
