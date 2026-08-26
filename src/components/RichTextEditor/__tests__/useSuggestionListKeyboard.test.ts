import { describe, expect, it, vi } from 'vitest';
import { suggestionListKeyDown } from '~/components/RichTextEditor/useSuggestionListKeyboard';

function setup({ length, selectedIndex = 0 }: { length: number; selectedIndex?: number }) {
  const setSelectedIndex = vi.fn();
  const onSelect = vi.fn();
  const onMove = vi.fn();

  const press = (key: string) =>
    suggestionListKeyDown({
      event: { key } as KeyboardEvent,
      length,
      selectedIndex,
      setSelectedIndex,
      onSelect,
      onMove,
    });

  /** Runs the state updater the hook passed to `setSelectedIndex`, from the current index. */
  const nextIndex = () => setSelectedIndex.mock.calls[0][0](selectedIndex);

  return { press, nextIndex, onSelect, onMove };
}

describe('suggestionListKeyDown', () => {
  it('moves down, and wraps past the end', () => {
    const first = setup({ length: 3, selectedIndex: 0 });
    first.press('ArrowDown');
    expect(first.nextIndex()).toBe(1);

    const last = setup({ length: 3, selectedIndex: 2 });
    last.press('ArrowDown');
    expect(last.nextIndex()).toBe(0);
  });

  it('moves up, and wraps past the start', () => {
    const top = setup({ length: 3, selectedIndex: 0 });
    top.press('ArrowUp');
    expect(top.nextIndex()).toBe(2);
  });

  it.each(['Enter', 'Tab'])('%s selects the current index', (key) => {
    const { press, onSelect } = setup({ length: 3, selectedIndex: 1 });

    expect(press(key)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('reports an unhandled key so the editor still receives it', () => {
    expect(setup({ length: 3 }).press('a')).toBe(false);
  });

  it('tells a virtualized list where the selection went', () => {
    const { press, nextIndex, onMove } = setup({ length: 3, selectedIndex: 0 });

    press('ArrowDown');
    nextIndex();
    expect(onMove).toHaveBeenCalledWith(1);
  });

  // 🔴 The case the hand-written copies disagreed on, and the reason this is shared at all.
  // `% 0` is NaN, which sticks in state and silently breaks every later keypress.
  describe('an empty list', () => {
    it('never produces NaN', () => {
      const { press, nextIndex } = setup({ length: 0, selectedIndex: 0 });

      press('ArrowDown');
      expect(Number.isNaN(nextIndex())).toBe(false);
      expect(nextIndex()).toBe(0);
    });

    it('selects nothing on Enter, and passes the key on', () => {
      const { press, onSelect } = setup({ length: 0 });

      expect(press('Enter')).toBe(false);
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
