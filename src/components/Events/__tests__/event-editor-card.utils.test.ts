import { describe, expect, it } from 'vitest';
import { editorHatState } from '~/components/Events/event-editor-card.utils';

const hat = (id: number, placedOn: { entityType: string; entityId: number } | null = null) => ({
  id,
  placedOn,
});
const ARTICLE = { entityType: 'Article', entityId: 7 };

describe('editorHatState', () => {
  it('asks a viewer with no hats to join', () => {
    expect(editorHatState([], ARTICLE)).toEqual({ kind: 'join' });
  });

  it('offers a hat when none is on this content, even one on another type with the same id', () => {
    const hats = [
      hat(1),
      hat(2, { entityType: 'Image', entityId: 7 }),
      hat(3, { ...ARTICLE, entityId: 8 }),
    ];
    expect(editorHatState(hats, ARTICLE)).toEqual({ kind: 'add' });
  });

  it('is the hat on this content', () => {
    const hats = [hat(1), hat(2, ARTICLE)];
    expect(editorHatState(hats, ARTICLE)).toEqual({ kind: 'worn', hat: hats[1] });
  });
});
