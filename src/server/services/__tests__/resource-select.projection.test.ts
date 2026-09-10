import fs from 'fs';
import path from 'path';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';

// filterPreferences is pure and takes everything as explicit args, but the module it
// lives in pulls @grafana/faro-web-sdk in at import time via the telemetry sink.
import { vi } from 'vitest';
vi.mock('~/utils/faro/feedDrop', () => ({ emitFeedNoImagesDrop: vi.fn() }));

import type { HiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { filterResourceVersions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import {
  projectResourceSelectItems,
  RESOURCE_SELECT_IMAGE_KEYS,
  RESOURCE_SELECT_IMAGES_PER_MODEL,
  RESOURCE_SELECT_MODEL_KEYS,
  RESOURCE_SELECT_VERSION_KEYS,
} from '~/server/services/resource-select.projection';
import type { TransformedModel } from '~/shared/search/models-transform';

/**
 * Guards the `model.getResourceSelect` wire projection.
 *
 * The projection has a large number of ways to fail SILENTLY — with no error, no log,
 * and an empty picker that claims "No models found". `versions[].canGenerate` alone is
 * compared by identity and is tri-state, so dropping it or coercing `undefined` to
 * `false` strips every version from every model. Several others (model `nsfwLevel`,
 * `nsfw`, `minor`, `poi`, per-image `nsfwLevel`/`tags`) route through the
 * hidden-preferences pass, which deletes the model outright and deliberately does NOT
 * count that in the `hiddenCount` shown to the user.
 *
 * So the primary assertion is DIFFERENTIAL: run the picker's real client-side pipeline
 * over the raw page and over the projected page, and require an identical funnel. It
 * uses the real `filterPreferences` and the real `filterResourceVersions` — not copies,
 * which would not drift when those do.
 *
 * Fixtures are trimmed captures of two live pages from civitai.red on 2026-07-31
 * (Checkpoint/Illustrious and LORA+LoCon+DoRA+TextualInversion/Illustrious). Long
 * strings are truncated and volume is reduced, but every KEY is intact and the trap
 * coverage is preserved deliberately: the tri-state canGenerate, models above and below
 * the image cap, and models whose distinct nsfwLevels are spread with a rare level LAST
 * in the array. The raw pages measured 1,562,693 and 1,646,619 bytes.
 *
 * Do NOT regenerate these from an already-projected response — that would silently zero
 * out every assertion here.
 */

const FIXTURES = path.join(__dirname, 'fixtures');
function loadPage(name: string): TransformedModel[] {
  const env = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  return (superjson.deserialize(env) as { items: TransformedModel[] }).items;
}

const emptyPrefs = (): HiddenPreferencesState => ({
  hiddenUsers: new Map(),
  hiddenTags: new Map(),
  hiddenModels: new Map(),
  hiddenModel3Ds: new Map(),
  hiddenImages: new Map(),
  hiddenLoading: false,
  moderatedTags: [],
  systemHiddenTags: new Map(),
});

// PG (1), PG|PG13 (3, the public default) and a wide level, because a bad image cap
// shows up first at the most restrictive level.
const BROWSING_LEVELS = [1, 3, 31];

const PAGES = [
  {
    name: 'checkpoint page',
    file: 'resource-select-ckpt-page.json',
    opts: {
      tab: 'all' as const,
      selectSource: 'generation',
      canGenerate: true,
      resources: [{ type: 'Checkpoint', baseModels: ['Illustrious'] }],
      excludedIds: [],
    },
  },
  {
    name: 'lora page',
    file: 'resource-select-lora-page.json',
    opts: {
      tab: 'all' as const,
      selectSource: 'generation',
      canGenerate: true,
      resources: [
        { type: 'LORA', baseModels: ['Illustrious'] },
        { type: 'LoCon', baseModels: ['Illustrious'] },
        { type: 'DoRA', baseModels: ['Illustrious'] },
        { type: 'TextualInversion', baseModels: ['Illustrious'] },
      ],
      excludedIds: [],
    },
  },
];

/** The picker's real pipeline: hidden preferences, then per-version filtering. */
function funnel(
  items: TransformedModel[],
  browsingLevel: number,
  opts: (typeof PAGES)[number]['opts']
) {
  const { items: kept } = filterPreferences({
    type: 'models',
    data: items as never,
    hiddenPreferences: emptyPrefs(),
    browsingLevel,
    currentUser: null as never,
    canViewNsfw: true,
  });
  const rendered = (kept as unknown as TransformedModel[])
    .map((model) => ({ model, versions: filterResourceVersions(model, opts) }))
    .filter((x) => x.versions.length > 0);

  return {
    shipped: items.length,
    afterPreferences: kept.length,
    rendered: rendered.length,
    // Every rendered card dereferences images[0], so a missing cover is a crash.
    withCover: rendered.filter((x) => !!x.model.images[0]).length,
    renderedIds: rendered.map((x) => x.model.id),
    offeredVersionIds: rendered.map((x) => x.versions.map((v) => v.id)),
  };
}

describe.each(PAGES)('resource-select projection — $name', ({ file, opts }) => {
  const raw = loadPage(file);
  const projected = projectResourceSelectItems(raw);

  it('has a non-trivial fixture (guards against a silently emptied fixture)', () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.flatMap((m) => m.versions).length).toBeGreaterThan(raw.length);
    expect(raw.some((m) => m.images.length > RESOURCE_SELECT_IMAGES_PER_MODEL)).toBe(true);
    expect(raw.some((m) => new Set(m.images.map((i) => i.nsfwLevel)).size > 1)).toBe(true);
  });

  it.each(BROWSING_LEVELS)(
    'renders exactly the same cards and versions after projection (browsingLevel %i)',
    (browsingLevel) => {
      expect(funnel(projected as never, browsingLevel, opts)).toEqual(
        funnel(raw, browsingLevel, opts)
      );
    }
  );

  it('emits no key outside the model whitelist', () => {
    const allowed = new Set<string>(RESOURCE_SELECT_MODEL_KEYS);
    for (const item of projected) {
      // Subset, not equality: pick() preserves an absent optional key as absent rather
      // than inventing it, so a model legitimately missing e.g. `cosmetic` is fine.
      // What must never happen is an EXTRA key surviving the projection.
      expect([...Object.keys(item)].filter((k) => !allowed.has(k))).toEqual([]);
    }
    // The keys every model must carry, because a consumer dereferences them unguarded.
    for (const item of projected) {
      for (const key of ['id', 'name', 'type', 'nsfwLevel', 'versions', 'images', 'hashes']) {
        expect(item).toHaveProperty(key);
      }
    }
  });

  it('emits no key outside the version and image whitelists', () => {
    const versionKeys = new Set<string>(RESOURCE_SELECT_VERSION_KEYS);
    const imageKeys = new Set<string>([...RESOURCE_SELECT_IMAGE_KEYS, 'metadata']);
    for (const item of projected) {
      for (const version of item.versions) {
        expect([...Object.keys(version)].filter((k) => !versionKeys.has(k))).toEqual([]);
        // Read unguarded by filterResourceVersions.
        expect(version).toHaveProperty('id');
        expect(version).toHaveProperty('baseModel');
      }
      for (const image of item.images) {
        expect([...Object.keys(image)].filter((k) => !imageKeys.has(k))).toEqual([]);
        for (const key of ['id', 'url', 'nsfwLevel', 'width', 'height', 'hash']) {
          expect(image).toHaveProperty(key);
        }
      }
    }
  });

  it('preserves the canGenerate tri-state exactly', () => {
    // filterResourceVersions keeps a version only when `canGenerate === true`, so the
    // set of true-valued versions is what decides the entire visible list. Absent and
    // `undefined` must also stay distinct: collapsing them is behaviourally identical
    // but silently changes the wire.
    const census = (items: TransformedModel[]) => {
      const c = { true: 0, false: 0, undefined: 0, absent: 0 } as Record<string, number>;
      const trueIds: number[] = [];
      for (const m of items)
        for (const v of m.versions) {
          if (!('canGenerate' in v)) c.absent++;
          else {
            c[String(v.canGenerate)]++;
            if (v.canGenerate === true) trueIds.push(v.id);
          }
        }
      return { c, trueIds };
    };
    expect(census(projected as never)).toEqual(census(raw));
  });

  it('caps images per model without losing anyone their only cover', () => {
    for (const item of projected) {
      expect(item.images.length).toBeLessThanOrEqual(RESOURCE_SELECT_IMAGES_PER_MODEL);
    }
    // Coverage property: every distinct nsfwLevel in the full array survives the cap,
    // which is what keeps a restrictive viewer from losing the model entirely.
    for (const [i, item] of projected.entries()) {
      const before = new Set(raw[i].images.map((im) => im.nsfwLevel));
      const after = new Set(item.images.map((im) => im.nsfwLevel));
      expect([...before].every((level) => after.has(level))).toBe(true);
    }
  });

  it('meaningfully shrinks the payload', () => {
    const before = JSON.stringify(raw).length;
    const after = JSON.stringify(projected).length;
    expect(after).toBeLessThan(before * 0.75);
  });
});
