import { describe, expect, it } from 'vitest';
import { slotRemountKey } from '../types';

/**
 * W10 — the entity-agnostic BlockSlot remount key. The model behavior (H-4:
 * force-unmount on model navigation) MUST be preserved when the key is widened
 * from the old `${slotId}:${modelId}` form.
 */
describe('slotRemountKey', () => {
  it('preserves model remount-on-nav behavior: changes when the modelId changes', () => {
    const a = slotRemountKey({ slotId: 'model.sidebar_top', entityType: 'model', entityId: 111 });
    const b = slotRemountKey({ slotId: 'model.sidebar_top', entityType: 'model', entityId: 222 });
    expect(a).not.toBe(b);
    // Same model + slot → stable key (no spurious remount).
    expect(a).toBe(
      slotRemountKey({ slotId: 'model.sidebar_top', entityType: 'model', entityId: 111 })
    );
    // The model key encodes the entity so it's distinguishable from a page key.
    expect(a).toBe('model.sidebar_top:model:111');
  });

  it('different slots on the same model produce different keys', () => {
    const top = slotRemountKey({ slotId: 'model.sidebar_top', entityType: 'model', entityId: 5 });
    const below = slotRemountKey({ slotId: 'model.below_images', entityType: 'model', entityId: 5 });
    expect(top).not.toBe(below);
  });

  it('keys a page on its slug (entity=none)', () => {
    expect(slotRemountKey({ slotId: 'app.page', entityType: 'none', entityId: 'hello' })).toBe(
      'app.page:none:hello'
    );
  });

  it('a null/undefined entityId falls back to "none"', () => {
    expect(slotRemountKey({ slotId: 'app.page', entityType: 'none' })).toBe('app.page:none:none');
    expect(
      slotRemountKey({ slotId: 'app.page', entityType: 'none', entityId: null })
    ).toBe('app.page:none:none');
  });

  it('a model key and a page key never collide', () => {
    const model = slotRemountKey({ slotId: 'model.sidebar_top', entityType: 'model', entityId: 1 });
    const page = slotRemountKey({ slotId: 'app.page', entityType: 'none', entityId: '1' });
    expect(model).not.toBe(page);
  });
});
