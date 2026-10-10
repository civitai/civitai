import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { withUserLights } from '~/server/redis/entity-cosmetic-lights';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';

type DecorationData = ContentDecorationCosmetic['data'];

describe('withUserLights (#3912)', () => {
  it('does not write one entity lights onto the cosmetic data other entities share', () => {
    // cosmeticCache.fetch hands every entity equipping the same cosmetic the same
    // `data` object within one appendFn pass.
    const shared: DecorationData = { url: 'frame.png', lights: 3 };
    const first = withUserLights(shared, { lights: 7 });
    const second = withUserLights(shared, {});

    expect(first.lights).toBe(7);
    expect(second.lights).toBe(3);
    expect(shared).toEqual({ url: 'frame.png', lights: 3 });
  });

  it('keeps the rest of the cosmetic data', () => {
    expect(withUserLights({ url: 'frame.png', color: 'red' }, { lights: 2 })).toEqual({
      url: 'frame.png',
      color: 'red',
      lights: 2,
    });
  });

  it('returns the cosmetic data unchanged when the user set no lights', () => {
    const shared: DecorationData = { url: 'frame.png' };
    expect(withUserLights(shared, {})).toBe(shared);
  });
});

describe('cosmeticEntityCaches appendFn', () => {
  // caches.ts builds its singletons at import time and cannot be imported from a
  // unit test (see image-meta-cache-compress.test.ts), so pin the call site instead.
  const source = readFileSync(path.join(process.cwd(), 'src/server/redis/caches.ts'), 'utf8');

  it('merges user lights through withUserLights rather than mutating record.data', () => {
    expect(source.includes('withUserLights(')).toBe(true);
    expect(/record\.data\.lights\s*=/.test(source)).toBe(false);
  });
});
