import { beforeEach, describe, expect, it } from 'vitest';
import { useStickerPlacementDraftStore as store } from '~/store/sticker-placement-draft.store';

const draft = () => store.getState().drafts[0];

describe('a draft in Movement', () => {
  beforeEach(() => {
    store.getState().close();
    store.getState().open(74);
    store.getState().begin(9, { x: 0.2, y: 0.5 });
  });

  it('a copy of a draft in Movement is Static and drawn at its own opacity', () => {
    const { setMotion, setKeys, setPlayhead, duplicateDraft } = store.getState();
    setMotion(draft().id, true);
    const [first] = draft().motion!.keys;
    setKeys(draft().id, [{ ...first, o: 0 }]);
    setPlayhead(0);
    expect(draft().shown).toBe(0);

    const copyId = duplicateDraft(draft().id)!;
    const copy = store.getState().drafts.find((d) => d.id === copyId)!;
    expect(copy.motion).toBeUndefined();
    expect(copy.shown).toBeUndefined();
  });

  it('sets a key where the playhead is when it is moved, and plays between its keys', () => {
    const { setMotion, setPlayhead, move } = store.getState();
    setMotion(draft().id, true);
    setPlayhead(2000);
    move(draft().id, { x: 0.8 });
    expect(draft().motion?.keys.map((k) => [k.t, k.x])).toEqual([
      [0, 0.2],
      [2000, 0.8],
    ]);

    setPlayhead(0);
    expect(draft().x).toBe(0.2);
    setPlayhead(2000);
    expect(draft().x).toBe(0.8);
  });

  it('sets no key for a flip or for the sticker’s own opacity', () => {
    const { setMotion, setPlayhead, move } = store.getState();
    setMotion(draft().id, true);
    setPlayhead(1000);
    move(draft().id, { flip: true, opacity: 0.6 });
    expect(draft().motion?.keys).toHaveLength(1);
  });

  it('keeps its keys parked in Static, where moving it sets none', () => {
    const { setMotion, setPlayhead, move } = store.getState();
    setMotion(draft().id, true);
    setPlayhead(1000);
    move(draft().id, { x: 0.7 });
    setMotion(draft().id, false);
    setPlayhead(0);
    move(draft().id, { y: 0.1 });
    expect(draft()).toMatchObject({ x: 0.7, y: 0.1 });
    expect(draft().motion).toMatchObject({ on: false });
    expect(draft().motion?.keys).toHaveLength(2);
  });
});
