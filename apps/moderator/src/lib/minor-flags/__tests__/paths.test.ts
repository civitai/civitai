import { describe, expect, it } from 'vitest';
import { NAVIGATION } from '$lib/server/access';
import { MODEL_FLAGS_PATH, MODEL_FLAG_TAB_HINTS } from '$lib/minor-flags/paths';

describe('MODEL_FLAG_TAB_HINTS', () => {
  it('has a hint for every tab the Model Flags group declares, and no others', () => {
    const group = NAVIGATION.find((n) => n.path === '/models')?.children?.find(
      (link) => link.path === MODEL_FLAGS_PATH
    );
    const tabPaths = (group?.children ?? []).map((child) => child.path).sort();
    expect(tabPaths.length).toBe(3);
    expect(Object.keys(MODEL_FLAG_TAB_HINTS).sort()).toEqual(tabPaths);
  });
});
