import { useHotkeys } from '@mantine/hooks';

const EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * Whether the key was typed into an editable field. Reads the event's original target, not
 * `event.target`: a shadow root retargets `event.target` to its host element, so Mantine's own
 * check misses a textarea inside one (the App Assistant's `<civitai-chat>`).
 */
export function isTypingInEditable(event: KeyboardEvent) {
  const origin = event.composedPath()[0];
  if (!(origin instanceof HTMLElement)) return false;
  return origin.isContentEditable || EDITABLE_TAGS.includes(origin.tagName);
}

/** `/` and mod+K focus the site search, except while the user is typing in a field. */
export function useSearchFocusHotkeys(focus: () => void) {
  const handler = (event: KeyboardEvent) => {
    if (isTypingInEditable(event)) return;
    event.preventDefault();
    focus();
  };
  useHotkeys([
    ['/', handler, { preventDefault: false }],
    ['mod+k', handler, { preventDefault: false }],
  ]);
}
