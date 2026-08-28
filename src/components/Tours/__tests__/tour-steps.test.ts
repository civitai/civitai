import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { GENERATION_TAB_KEYS } from '~/components/ImageGeneration/GenerationTabs';
import { tourScrollBlock } from '~/components/Tours/tour-scroll';
import { tourSteps } from '~/components/Tours/tours';

const SRC = path.resolve(__dirname, '../../..');
const TOUR_DEFINITIONS = path.join(SRC, 'components', 'Tours', 'tours');

// `gen:reset` and `gen:results` are rendered but targeted by no step. `${target}` and
// `${tourTarget}` are the naive regex matching its own capture group against a template
// literal selector (GenerationForm.tsx, RemixMenu.tsx) rather than a literal attribute, and
// `([^` is the same regex matching its own source text in joyride-callback.ts. None of these
// is this guard's business to fix — but listing them means the NEXT orphaned attribute fails
// here instead of quietly joining them.
const UNTARGETED_ATTRIBUTES = ['gen:reset', 'gen:results', '${target}', '${tourTarget}', '([^'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The definitions name every key by construction, and a key mentioned
      // only in a test is still a step pointing at nothing.
      if (entry.name === '__tests__' || full === TOUR_DEFINITIONS) return [];
      return sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const tourTargetKeys = Object.entries(tourSteps).flatMap(([tour, steps]) =>
  steps.map((step) => {
    const match = /^\[data-tour="([^"]+)"\]$/.exec(String(step.target));
    return { tour, target: String(step.target), key: match?.[1] };
  })
);

describe('tour steps point at something', () => {
  it('targets a data-tour attribute, so the key below is checkable', () => {
    expect(tourTargetKeys.filter((t) => !t.key).map((t) => `${t.tour}: ${t.target}`)).toEqual([]);
  });

  /**
   * A step whose target is absent is not an error anyone sees: Joyride treats
   * `TARGET_NOT_FOUND` as "next", so the step silently vanishes and the numbering
   * jumps. `model:download` sat dead this way from #1964 until 2026-08-27,
   * because the attribute went with the download UI rewrite and nothing failed.
   */
  it('names a data-tour key that some component still renders', () => {
    const rendered = sourceFiles(SRC).map((file) => readFileSync(file, 'utf-8'));
    // `gen:queue`/`gen:feed`/`gen:generate` are template-literal-built (see the `gen:
    // namespace` block below), so no source file holds them as a literal string — this
    // is a narrow, enumerated exemption for exactly those three, not the old blanket
    // "anything starting with gen:" one this guard used to carry.
    const orphans = [...new Set(tourTargetKeys.map((t) => t.key))].filter(
      (key) =>
        !rendered.some((source) => source.includes(`'${key}'`) || source.includes(`"${key}"`)) &&
        !GENERATION_TAB_KEYS.some((tab) => key === `gen:${tab}`)
    );
    expect(orphans).toEqual([]);
  });
});

describe('the gen: namespace', () => {
  /**
   * `GenerationTabs` builds `data-tour={`gen:${key}`}` from the tab map, so no source
   * file holds the literal string and the orphan check above cannot see these at all.
   */
  it('names a tab that GenerationTabs actually renders', () => {
    const genTabTargets = tourTargetKeys
      .map((t) => t.key)
      .filter((key): key is string => !!key && key.startsWith('gen:'))
      .filter(
        (key) =>
          ![
            'gen:start',
            'gen:terms',
            'gen:prompt',
            'gen:remix',
            'gen:remix-menu',
            'gen:submit',
            'gen:buzz',
            'gen:select',
            'gen:post',
          ].includes(key)
      );

    const unknown = genTabTargets.filter(
      (key) => !GENERATION_TAB_KEYS.some((tab) => key === `gen:${tab}`)
    );

    expect(unknown).toEqual([]);
  });

  it('renders a tab for every gen: tab target a tour names', () => {
    expect([...GENERATION_TAB_KEYS]).toEqual(expect.arrayContaining(['queue', 'feed']));
  });
});

describe('data-tour attributes nothing targets', () => {
  it('has not grown since it was last looked at', () => {
    const rendered = sourceFiles(SRC).map((file) => readFileSync(file, 'utf-8'));
    const declared = new Set(
      rendered.flatMap((source) => [...source.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]))
    );
    const targeted = new Set(tourTargetKeys.map((t) => t.key));
    const untargeted = [...declared].filter((key) => !targeted.has(key)).sort();

    expect(untargeted).toEqual([...UNTARGETED_ATTRIBUTES].sort());
  });
});

// Clicking a remix button opens a menu rather than the generator, so each tour
// that spotlights one spends a step on the button and the next on the options it
// reveals. Collapsing them back into one leaves the menu undescribed.
describe.each([
  ['content-generation', 'gen:remix'],
  ['model-page', 'model:remix'],
  ['welcome', 'model:remix'],
] as const)('the %s remix steps', (tour, button) => {
  const targets = () => tourSteps[tour].map((step) => String(step.target));

  it('follows the button step with one on the menu it opens', () => {
    const index = targets().indexOf(`[data-tour="${button}"]`);

    expect(index).toBeGreaterThan(-1);
    expect(targets()[index + 1]).toBe(`[data-tour="${button}-menu"]`);
  });

  it('leaves the menu step a way forward for an image every engine refuses', () => {
    const menuStep = tourSteps[tour].find((step) => step.target === `[data-tour="${button}-menu"]`);

    expect(menuStep?.hideFooter).not.toBe(true);
  });
});

describe('the content-generation remix steps', () => {
  /**
   * `GenerationForm` used to cut the signed-out tour with `slice(0, 6)`, so
   * inserting a step silently pushed `gen:submit` off the end. The cuts name
   * their last step now; this fails if one goes back to an index.
   */
  it('is cut by target rather than by index', () => {
    const source = readFileSync(
      path.join(SRC, 'components', 'generation_v2', 'GenerationForm.tsx'),
      'utf-8'
    );

    expect(source).not.toMatch(/genSteps\.slice\(\s*0\s*,\s*-?\d/);
    expect(source).toContain("through(genSteps, 'gen:submit')");
  });
});

describe('TourPopover', () => {
  /**
   * The close button rendered for a year without `closeProps`, so the X was
   * decorative in every tour while Esc still worked. Destructuring a render
   * prop and not spreading it produces no type error and no test failure.
   */
  it('wires every render prop it destructures', () => {
    const source = readFileSync(path.join(SRC, 'components', 'Tour', 'TourPopover.tsx'), 'utf-8');
    const destructured = [...source.matchAll(/^\s{4}(\w+Props),$/gm)].map((m) => m[1]);
    const unwired = destructured.filter(
      (name) => !source.includes(`{...${name}}`) && !source.includes(`${name}.onClick`)
    );

    expect(destructured.length).toBeGreaterThan(0);
    expect(unwired).toEqual([]);
  });
});

describe('tourScrollBlock', () => {
  /**
   * `model:gallery` targets the wrapper around the whole gallery so the step
   * has something to aim at before the feed mounts. That wrapper is as tall as
   * the feed, and centering it puts the user `(height - viewport) / 2` below
   * its top — hundreds of images past the heading the step is describing.
   */
  it('scrolls to the top of a target taller than the viewport', () => {
    expect(tourScrollBlock(5000, 806)).toBe('start');
    expect((5000 - 806) / 2).toBeGreaterThan(2000); // what centering would cost
  });

  it('still centres a target that fits', () => {
    expect(tourScrollBlock(40, 806)).toBe('center');
    expect(tourScrollBlock(806, 806)).toBe('center');
  });
});
