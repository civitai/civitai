import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Product decision: the model page menu no longer offers "Take Down". Archive and Bring Back stay,
 * and models already taken down keep their mode and can still be brought back. Do not restore the
 * menu item without a product sign-off.
 *
 * The item lived in a Mantine Menu dropdown, which mounts only once opened (Popover `keepMounted`
 * defaults to false), so this reads the page source rather than rendering it.
 */
const pageSource = readFileSync(
  path.resolve(__dirname, '../../../pages/models/[id]/[[...slug]].tsx'),
  'utf8'
);

describe('model page menu', () => {
  it('offers no Take Down action', () => {
    expect(pageSource, 'the model menu offers Take Down again').not.toMatch(/Take Down/i);
    // The page may still read the mode (`=== / !== ModelModifier.TakenDown`), never set it.
    const writes = [...pageSource.matchAll(/(.{0,4})ModelModifier\.TakenDown/g)].filter(
      ([, before]) => !/[!=]==\s*$/.test(before)
    );
    expect(
      writes.map(([m]) => m),
      'the model page sets TakenDown again'
    ).toEqual([]);
  });

  it('still offers Archive and Bring Back', () => {
    expect(pageSource, 'Archive is gone from the model menu').toMatch(
      /handleChangeMode\(\s*ModelModifier\.Archived\s*\)/
    );
    expect(pageSource, 'Bring Back is gone from the model menu').toMatch(
      /handleChangeMode\(\s*null\s*\)/
    );
  });
});
