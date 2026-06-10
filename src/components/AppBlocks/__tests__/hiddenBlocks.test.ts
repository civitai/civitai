// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideBlock, isBlockHidden, unhideBlock } from '../hiddenBlocks';
import type { HiddenBlock } from '../hiddenBlocks';

const STORAGE_KEY = 'civitai:app-blocks:hidden';
const HIDDEN_CHANGED_EVENT = 'civitai:app-blocks:hidden-changed';

function block(id: string, extra: Partial<HiddenBlock> = {}): HiddenBlock {
  return { blockInstanceId: id, hiddenAt: 1000, ...extra };
}

afterEach(() => {
  window.localStorage.clear();
});

/**
 * Viewer-local "Hide app block" persistence. A model owner's block shows to
 * every viewer; hiding it is a per-viewer, per-instance localStorage flag that
 * never touches the server. BlockSlotClient filters hidden instances out before
 * mount; the /apps/installed "Hidden" tab restores them.
 */
describe('hiddenBlocks', () => {
  it('nothing is hidden by default', () => {
    expect(isBlockHidden('bki_1')).toBe(false);
  });

  it('hideBlock persists metadata and isBlockHidden reads it back', () => {
    hideBlock(block('bki_1', { appName: 'Gen', modelId: 42, modelName: 'Misty' }));
    expect(isBlockHidden('bki_1')).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.bki_1).toMatchObject({
      blockInstanceId: 'bki_1',
      appName: 'Gen',
      modelId: 42,
      modelName: 'Misty',
    });
  });

  it('is per-instance: hiding one block does not hide another', () => {
    hideBlock(block('bki_1'));
    expect(isBlockHidden('bki_1')).toBe(true);
    expect(isBlockHidden('bki_2')).toBe(false);
  });

  it('unhideBlock restores a hidden block', () => {
    hideBlock(block('bki_1'));
    expect(isBlockHidden('bki_1')).toBe(true);
    unhideBlock('bki_1');
    expect(isBlockHidden('bki_1')).toBe(false);
  });

  it('hide is idempotent and only fires the change event on a real change', () => {
    const onChange = vi.fn();
    window.addEventListener(HIDDEN_CHANGED_EVENT, onChange);
    hideBlock(block('bki_1'));
    hideBlock(block('bki_1')); // duplicate — no-op, no event
    expect(onChange).toHaveBeenCalledTimes(1);
    unhideBlock('bki_1');
    unhideBlock('bki_1'); // already gone — no-op, no event
    expect(onChange).toHaveBeenCalledTimes(2);
    window.removeEventListener(HIDDEN_CHANGED_EVENT, onChange);
  });

  it('migrates the legacy string[] shape to the record shape', () => {
    // The first shipped version stored a bare array of instance ids.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['bki_legacy']));
    expect(isBlockHidden('bki_legacy')).toBe(true);
    // A subsequent write upgrades the store to the record shape.
    hideBlock(block('bki_new'));
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(Array.isArray(stored)).toBe(false);
    expect(Object.keys(stored).sort()).toEqual(['bki_legacy', 'bki_new']);
  });

  it('tolerates a corrupt stored value (treats as nothing hidden)', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(isBlockHidden('bki_1')).toBe(false);
    hideBlock(block('bki_1')); // repairs the store
    expect(isBlockHidden('bki_1')).toBe(true);
  });
});
