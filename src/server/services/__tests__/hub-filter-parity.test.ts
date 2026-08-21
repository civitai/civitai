import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  hubExcludedFilterKeys,
  mediaFilterKeys,
} from '~/components/Image/Filters/media-filter-keys';
import { hubFeedFiltersSchema } from '~/server/schema/user-hub.schema';

/**
 * A hub's filters live on its row, so every control the dropdown offers inside a
 * hub has to have somewhere to be stored. A control with no home is not a visible
 * failure — it applies for the session, then silently forgets itself on reload,
 * which reads as a bug in the hub rather than a missing field.
 *
 * `mediaFilterKeys` is hand-maintained, so a list-vs-list check cannot catch a
 * chip added to the JSX and to nothing else — a hand-enumerated test cannot catch
 * a hand-enumeration bug. The source scan below is what closes that direction.
 */

// Stored in their own columns rather than in `metadata.filters`, so they are
// persistable without appearing in the schema below.
const HUB_COLUMNS = ['period', 'types'] as const;

const dropdownSource = readFileSync(
  path.join(process.cwd(), 'src/components/Image/Filters/MediaFiltersDropdown.tsx'),
  'utf8'
);

describe('every hub filter control can be persisted', () => {
  const persistable = new Set<string>([...HUB_COLUMNS, ...Object.keys(hubFeedFiltersSchema.shape)]);

  it('has no offered control without a home', () => {
    const offered = mediaFilterKeys.filter((key) => !hubExcludedFilterKeys.includes(key));
    const homeless = offered.filter((key) => !persistable.has(key));

    expect(homeless).toEqual([]);
    // The guard on the guard: excluding everything would pass the assertion above
    // while leaving the hub with no filter menu at all.
    expect(offered.length).toBeGreaterThan(5);
  });
});

describe('the key list matches what the dropdown actually renders', () => {
  // Every control writes through `handleChange({ <key>: ... })`, so the keys it
  // passes are the controls it renders.
  const rendered = [...dropdownSource.matchAll(/handleChange\(\{\s*(\w+):/g)].map((m) => m[1]);

  it('finds the controls at all', () => {
    // Fails closed: a refactor that renames `handleChange` or moves the calls
    // would otherwise leave both assertions below passing over an empty list.
    expect(new Set(rendered).size).toBeGreaterThan(10);
  });

  it('has a key for every control the dropdown renders', () => {
    const unlisted = [...new Set(rendered)].filter(
      (key) => !(mediaFilterKeys as readonly string[]).includes(key)
    );

    expect(unlisted).toEqual([]);
  });

  it('clears every control it renders', () => {
    // `handleClear` resets a hand-listed object. A key missing from it means Clear
    // silently leaves that filter applied, which is the same class of bug.
    const reset = dropdownSource.slice(
      dropdownSource.indexOf('const reset = {'),
      dropdownSource.indexOf('const {', dropdownSource.indexOf('const reset = {'))
    );
    const cleared = new Set([...reset.matchAll(/(\w+): undefined/g)].map((m) => m[1]));
    // `period` is cleared on its own line below the object, for the reason the
    // comment there gives.
    const uncleared = [...new Set(rendered)].filter((key) => key !== 'period' && !cleared.has(key));

    expect(uncleared).toEqual([]);
  });
});
