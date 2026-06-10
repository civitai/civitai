// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideBlock, isBlockHidden } from '../hiddenBlocks';

const STORAGE_KEY = 'civitai:app-blocks:hidden';
const HIDDEN_CHANGED_EVENT = 'civitai:app-blocks:hidden-changed';

afterEach(() => {
  window.localStorage.clear();
});

/**
 * Viewer-local "Hide app block" persistence. A model owner's block shows to
 * every viewer; hiding it is a per-viewer, per-instance localStorage flag that
 * never touches the server. BlockSlotClient filters hidden instances out before
 * mount, so a hidden block never issues a token.
 */
describe('hiddenBlocks', () => {
  it('nothing is hidden by default', () => {
    expect(isBlockHidden('bki_1')).toBe(false);
  });

  it('hideBlock persists to localStorage and isBlockHidden reads it back', () => {
    hideBlock('bki_1');
    expect(isBlockHidden('bki_1')).toBe(true);
    // Persisted as a JSON string array under the shared key — survives reload.
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual(['bki_1']);
  });

  it('is per-instance: hiding one block does not hide another', () => {
    hideBlock('bki_1');
    expect(isBlockHidden('bki_1')).toBe(true);
    expect(isBlockHidden('bki_2')).toBe(false);
  });

  it('accumulates multiple hidden instances and is idempotent', () => {
    hideBlock('bki_1');
    hideBlock('bki_2');
    hideBlock('bki_1'); // duplicate — no-op
    expect(new Set(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!))).toEqual(
      new Set(['bki_1', 'bki_2'])
    );
  });

  it('dispatches the in-page change event so a mounted slot can re-filter', () => {
    const onChange = vi.fn();
    window.addEventListener(HIDDEN_CHANGED_EVENT, onChange);
    hideBlock('bki_1');
    expect(onChange).toHaveBeenCalledTimes(1);
    // A duplicate hide is a no-op and does NOT re-fire (avoids redundant rerenders).
    hideBlock('bki_1');
    expect(onChange).toHaveBeenCalledTimes(1);
    window.removeEventListener(HIDDEN_CHANGED_EVENT, onChange);
  });

  it('tolerates a corrupt stored value (treats as nothing hidden)', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(isBlockHidden('bki_1')).toBe(false);
    // And a subsequent hide repairs the store.
    hideBlock('bki_1');
    expect(isBlockHidden('bki_1')).toBe(true);
  });
});
