import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { tourSteps } from '~/components/Tours/tours';

const SRC = path.resolve(__dirname, '../../..');
const TOUR_DEFINITIONS = path.join(SRC, 'components', 'Tours', 'tours');

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
    // `data-tour={`gen:${key}`}` in GenerationTabs builds its keys from the
    // panel's tab names, so no file holds the whole string. Anything under such
    // a prefix is out of this guard's reach — today that is the `gen:` half of
    // the generation panel, and `model:`/`post:`/`auction:` stay fully covered.
    const computedPrefixes = rendered.flatMap((source) =>
      [...source.matchAll(/data-tour=\{`([^`$]+)\$\{/g)].map((m) => m[1])
    );
    const orphans = [...new Set(tourTargetKeys.map((t) => t.key))].filter(
      (key) =>
        !rendered.some((source) => source.includes(`'${key}'`) || source.includes(`"${key}"`)) &&
        !computedPrefixes.some((prefix) => key?.startsWith(prefix))
    );
    expect(orphans).toEqual([]);
  });
});

describe('the content-generation remix steps', () => {
  // Clicking the remix button opens a menu rather than the generator, so the
  // tour spends a step on the button and the next on the options it reveals.
  // Collapsing them back into one leaves the menu undescribed.
  it('follows the button step with one on the menu it opens', () => {
    const targets = tourSteps['content-generation'].map((step) => String(step.target));
    const button = targets.indexOf('[data-tour="gen:remix"]');

    expect(button).toBeGreaterThan(-1);
    expect(targets[button + 1]).toBe('[data-tour="gen:remix-menu"]');
  });

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

  it('leaves the menu step a way forward for an image every engine refuses', () => {
    const menuStep = tourSteps['content-generation'].find(
      (step) => step.target === '[data-tour="gen:remix-menu"]'
    );

    expect(menuStep?.hideFooter).not.toBe(true);
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
