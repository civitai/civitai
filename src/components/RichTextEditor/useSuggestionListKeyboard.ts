import { useCallback } from 'react';

/** The shape `@tiptap/suggestion`'s `onKeyDown` expects a list component's ref to expose. */
export type SuggestionListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type Args = {
  length: number;
  selectedIndex: number;
  setSelectedIndex: (update: (prev: number) => number) => void;
  onSelect: (index: number) => void;
  /**
   * For a list that scrolls the selection into view from inside the state update (a virtualizer).
   * A list that does it in an effect keyed on the index needs nothing here.
   */
  onMove?: (index: number) => void;
};

/**
 * Arrow / Enter / Tab navigation for a suggestion popover's list.
 *
 * Shared rather than copied because the copies had already drifted on the case that is easiest to
 * get wrong and hardest to notice: an EMPTY list. `% 0` is `NaN`, which sticks in state and
 * silently breaks every later keypress — so the wrap is `Math.max(length, 1)` and Enter is
 * guarded, in one place.
 *
 * Exported as a plain function as well as a hook so the behaviour can be tested without a React
 * renderer — this repo has no `@testing-library/react`.
 */
export function suggestionListKeyDown({
  event,
  length,
  selectedIndex,
  setSelectedIndex,
  onSelect,
  onMove,
}: Args & { event: KeyboardEvent }): boolean {
  const step = (delta: number) => {
    setSelectedIndex((prev) => {
      const next = (prev + length + delta) % Math.max(length, 1);
      onMove?.(next);
      return next;
    });
    return true;
  };

  if (event.key === 'ArrowUp') return step(-1);
  if (event.key === 'ArrowDown') return step(1);
  if ((event.key === 'Enter' || event.key === 'Tab') && length > 0) {
    onSelect(selectedIndex);
    return true;
  }
  return false;
}

export function useSuggestionListKeyboard({
  length,
  selectedIndex,
  setSelectedIndex,
  onSelect,
  onMove,
}: Args): SuggestionListRef['onKeyDown'] {
  return useCallback(
    ({ event }: { event: KeyboardEvent }) =>
      suggestionListKeyDown({ event, length, selectedIndex, setSelectedIndex, onSelect, onMove }),
    [length, selectedIndex, setSelectedIndex, onSelect, onMove]
  );
}
