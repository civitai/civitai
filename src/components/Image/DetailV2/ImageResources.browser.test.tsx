import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

// The component project loads no global stylesheet, so both halves of this
// layout are inert unless a test imports them: Tailwind supplies `min-w-0` /
// `shrink-0`, and Mantine supplies the `lineClamp` rule. Without the Mantine
// sheet the name WRAPS to three lines instead of truncating, the row grows
// tall enough that nothing has to give sideways, and every measurement below
// passes on a layout that does not ship.
import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';

// Two names, because the two classes this file guards fail on different inputs.
// A spaced name pins `shrink-0`: the badge group is the only thing that can
// give. An unbroken one pins `min-w-0`: the link's content-based minimum is the
// whole token, so the row overflows no matter how firmly the badges hold. Both
// shapes are ordinary model names.
const SPACED_NAME = 'Rocket Raccoon - Marvel Cinematic Universe - Guardians of the Galaxy';
const UNBROKEN_NAME = 'Rocket_Raccoon_Marvel_Cinematic_Universe_Guardians_Of_The_Galaxy_v2';

let modelName = SPACED_NAME;

const generationData = {
  get resources() {
    return [
      {
        imageId: 1,
        versionId: 10,
        modelVersionId: 10,
        modelId: 100,
        modelName,
        modelType: 'LORA',
        versionName: 'v1.0',
        strength: 0.8,
      },
    ];
  },
};

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    image: {
      getGenerationData: { useQuery: () => ({ data: generationData, isLoading: false }) },
      removeResource: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({ image: { getGenerationData: { setData: vi.fn() } } }),
  },
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

import { ImageResources } from './ImageResources';
import { renderWithProviders } from '../../../../test/component-setup';

// The generation-data panel on the image page. 320px is the narrow end of it;
// the bug reproduces wherever the row is tight enough to force a choice.
const PANEL_WIDTH = 320;

afterEach(() => {
  modelName = SPACED_NAME;
});

async function renderPanel() {
  renderWithProviders(
    <div style={{ width: PANEL_WIDTH }}>
      <ImageResources imageId={1} />
    </div>
  );
  await vi.waitFor(() => {
    expect(document.body.querySelector('li')).toBeTruthy();
  });
}

function row() {
  return document.body.querySelector('li > div') as HTMLElement;
}

function strengthBadge() {
  const badges = Array.from(document.body.querySelectorAll('li .mantine-Badge-root'));
  const badge = badges.find((b) => b.textContent?.trim() === '0.8');
  // Without this, a reformatted value (`0.80`) or a Mantine class rename turns
  // every measurement below into `Cannot read properties of undefined`, with
  // none of the numbers this file exists to print.
  expect(badge, 'no badge rendering the strength value').toBeTruthy();
  return badge as HTMLElement;
}

function nameText() {
  // A resource with no `modelId` renders no link, so the Text sits directly
  // under the `min-w-0` div instead of under an `<a>`.
  return document.body.querySelector('li a p, li div > p') as HTMLElement;
}

// ⚠️ Nothing here gates `main`: `*.browser.test.tsx` runs in no blocking CI job
// (lint.yml keeps the unit job Node-only), only in the preview pipeline's
// report-only `component-tests`. A revert of either class below merges green.
//
// Reported 2026-08-17 (ClickUp 868ktabp0): in "Resources used" a strength of `1`
// rendered whole while `0.8` rendered as `0.`, clipped at the panel edge — on
// Chrome and Firefox both. The row is `justify-between` with two shrinkable
// children, and the name side would not shrink past its longest word, because
// `lineClamp`'s `overflow: hidden` sits on the Text and not on the link
// wrapping it. So the badge group was the one that gave.
describe('ImageResources row at a narrow panel width', () => {
  test('keeps the strength badge inside the panel', async () => {
    await renderPanel();

    // The badge is never clipped INTERNALLY — measured on the broken layout it
    // is a full-width 36px box sitting 42px past the panel edge, so its own
    // scrollWidth/clientWidth match and asserting on those passes for free.
    // What breaks is where it sits.
    expect(strengthBadge().getBoundingClientRect().right).toBeLessThanOrEqual(
      row().getBoundingClientRect().right + 1
    );
  });

  test('does not overflow the row', async () => {
    await renderPanel();

    // Same failure read off the container: 362 against a 320px row before the
    // fix. A revert prints both numbers.
    expect(row().scrollWidth).toBeLessThanOrEqual(row().clientWidth + 1);
  });

  test('keeps it inside for a name with no spaces to break on', async () => {
    modelName = UNBROKEN_NAME;
    await renderPanel();

    // `shrink-0` alone holds the SPACED name — the badge group stops giving and
    // the name wraps instead. It does nothing here: an unbroken token is the
    // link's content-based minimum, so without `min-w-0` the link refuses to
    // shrink and the row overruns with the badges still at full width. Deleting
    // `min-w-0` fails this and nothing else in the file.
    expect(row().scrollWidth).toBeLessThanOrEqual(row().clientWidth + 1);
    expect(strengthBadge().getBoundingClientRect().right).toBeLessThanOrEqual(
      row().getBoundingClientRect().right + 1
    );
  });

  test('truncates the resource name, so the row really is constrained', async () => {
    await renderPanel();

    // Control. The assertions above are all "X fits inside Y", which is also
    // true of a panel wide enough that nothing has to give — and a panel that
    // wide is precisely what a missing stylesheet produces here. This pins that
    // the row really is constrained. It is not describing a wider render: the
    // width is the same 320px, and widening it to match this comment would kill
    // the assertion. `lineClamp` is a one-line `-webkit-box`, so the overflow
    // it produces is VERTICAL — scrollWidth stays equal to clientWidth.
    const name = nameText();
    expect(name.scrollHeight).toBeGreaterThan(name.clientHeight);
  });
});
