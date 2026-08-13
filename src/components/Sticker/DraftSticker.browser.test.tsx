import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { DraftSticker } from '~/components/Sticker/DraftSticker';
import type { StickerTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';

/**
 * The two control layouts sit in different places in the tree — flush against
 * the sticker's own top corners while it is wide enough, inside the buy cluster
 * once it is not — so crossing the width that decides between them unmounts one
 * and mounts the other. Everything here is about what that crossing must not
 * cost: an open opacity slider, and a layout that changes its mind on every
 * frame of a resize.
 */

/**
 * Narrow enough to sit inside the browser-mode viewport. A media box wider than
 * the window puts the sticker's controls off the side of it, and a click on
 * something that cannot be scrolled into view fails as a 15s actionability
 * timeout rather than as anything about the sticker.
 */
const MEDIA_BOX_WIDTH = 260;

// Wide enough for the flush panels (182px), narrow enough to be well under the
// leave width (78px), and inside the hysteresis band (117px). Fractions of the
// media box, which is how a draft's scale is stored.
const WIDE = 0.7;
const NARROW = 0.3;
const IN_BAND = 0.45;

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useCreateStickerPlacement: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The button pulls in the Buzz balance, a tRPC query and a purchase path, none
// of which this is about. A plain button keeps the cluster's shape.
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ alt }: { alt: string }) => (
    // A real EdgeImage has no intrinsic size until it loads, and the sticker's
    // height feeds the flip decision. A fixed box makes both measurements
    // deterministic without touching the width, which is what is under test.
    <div aria-label={alt} style={{ width: '100%', height: 80 }} />
  ),
}));

const draft = (scale: number): StickerDraft => ({
  id: 'draft-1',
  imageId: 1,
  cosmeticId: 2,
  x: 0.5,
  y: 0.5,
  scale,
  rotation: 0,
  flip: false,
  opacity: 1,
});

/** No plate, no edge, no animation — nothing that would change the sticker's box. */
const PLAIN: StickerTreatment = { key: 'none', label: 'None', note: '' };

const art = {
  id: 2,
  slug: 'test-sticker',
  url: 'sticker.png',
  animated: false,
} as unknown as StickerUtil.ResolvedSticker;

const renderDraft = async (scale: number) => {
  const result = await renderWithProviders(
    <div style={{ position: 'relative', width: MEDIA_BOX_WIDTH, height: 400 }}>
      <DraftSticker
        draft={draft(scale)}
        art={art}
        selected
        dressed={PLAIN}
        price={100}
        ownerShare={undefined}
        ownerUsername={undefined}
        onGesture={() => true}
      />
    </div>
  );

  const resize = (next: number) =>
    result.rerender(
      <div style={{ position: 'relative', width: MEDIA_BOX_WIDTH, height: 400 }}>
        <DraftSticker
          draft={draft(next)}
          art={art}
          selected
          dressed={PLAIN}
          price={100}
          ownerShare={undefined}
          ownerUsername={undefined}
          onGesture={() => true}
        />
      </div>
    );

  return { resize };
};

/**
 * Which layout is live, read from DOM containment rather than from the position
 * classes: the flush panels hang off the sticker itself, the narrow layout puts
 * the same controls inside the buy cluster.
 */
const controlsAreInTheCluster = () => {
  const cluster = document.querySelector('[data-testid="sticker-buy-cluster"]');
  const flip = page.getByRole('button', { name: /flip this sticker/i }).element();
  return !!cluster?.contains(flip);
};

const sliders = () => page.getByRole('slider').elements().length;

const openOpacity = () =>
  page
    .getByRole('button', { name: /set this sticker's opacity/i })
    .element()
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));

describe('DraftSticker control geometry', () => {
  test('hands the controls to the buy cluster once the sticker is too narrow for them', async () => {
    const { resize } = await renderDraft(WIDE);
    // Arriving state, and it stays: safe to await.
    await expect.element(page.getByRole('button', { name: 'Place' })).toBeInTheDocument();
    expect(controlsAreInTheCluster()).toBe(false);

    await resize(NARROW);

    expect(controlsAreInTheCluster()).toBe(true);
  });

  // The band, not a shift of the line. A width inside it keeps whichever layout
  // it already had, so a resize gesture dragging the sticker through that region
  // does not swap the two on every frame.
  test('keeps the flush panels through the band under the width that earned them', async () => {
    const { resize } = await renderDraft(WIDE);
    await expect.element(page.getByRole('button', { name: 'Place' })).toBeInTheDocument();

    await resize(IN_BAND);

    expect(controlsAreInTheCluster()).toBe(false);
  });

  test('does not give a draft the flush panels merely for reaching the band', async () => {
    // The negative control for the case above: the same width, approached from
    // below, must NOT produce the flush layout — otherwise that test would pass
    // against a hysteresis that had simply moved the threshold down.
    const { resize } = await renderDraft(NARROW);
    await expect.element(page.getByRole('button', { name: 'Place' })).toBeInTheDocument();
    expect(controlsAreInTheCluster()).toBe(true);

    await resize(IN_BAND);

    expect(controlsAreInTheCluster()).toBe(true);
  });

  // The reason any of this matters. The opacity slider is the one piece of state
  // up there, and the layout swap destroys the element holding it.
  //
  // ⚠️ The open slider is a state that DELETES ITSELF on a regression, so it is
  // never awaited after the resize — a matcher polling for something already
  // gone can only ever time out. The awaits are all before the crossing, on
  // states that arrive and stay; the assertion that carries the test is read
  // synchronously on the commit the resize produced, so a revert fails in
  // milliseconds naming the count.
  test('keeps an open opacity slider open across the width that swaps the layouts', async () => {
    const { resize } = await renderDraft(WIDE);
    await expect.element(page.getByRole('button', { name: 'Place' })).toBeInTheDocument();

    // A DOM click, not the browser driver's. The controls are Mantine
    // `ActionIcon`s, which take their size entirely from Mantine's stylesheet —
    // absent here, so they measure 0x0 and the driver's actionability check
    // waits out its whole budget on an element that will never have a hit box.
    // That failure says nothing about the sticker, and the handler under test is
    // an ordinary onClick either way.
    openOpacity();
    await expect.element(page.getByRole('slider')).toBeInTheDocument();

    await resize(NARROW);

    expect(sliders()).toBe(1);
    // And in the layout it moved to, not orphaned beside the one it left.
    expect(controlsAreInTheCluster()).toBe(true);
  });

  // The other direction unmounts a different subtree — the control row inside
  // the buy cluster rather than the two flush pills — so one direction is only
  // half the claim.
  test('keeps an open opacity slider open going the other way too', async () => {
    const { resize } = await renderDraft(NARROW);
    await expect.element(page.getByRole('button', { name: 'Place' })).toBeInTheDocument();
    expect(controlsAreInTheCluster()).toBe(true);

    openOpacity();
    await expect.element(page.getByRole('slider')).toBeInTheDocument();

    await resize(WIDE);

    expect(sliders()).toBe(1);
    expect(controlsAreInTheCluster()).toBe(false);
  });

  // The other half of the reported symptom, and the half no slider count can
  // see. Mantine's own `returnFocus` cannot do this one: it captures the element
  // to return to in a hook that skips its first run, so a Popover remounting
  // already-open captures nothing and restores to null. Measured without the
  // fix, focus is left on a non-control `div` — not the body, and either way not
  // anywhere a keyboard user can carry on from.
  test('returns focus to the control that replaced the one it was opened from', async () => {
    const { resize } = await renderDraft(WIDE);
    await expect.element(page.getByRole('button', { name: 'Place' })).toBeInTheDocument();

    openOpacity();
    await expect.element(page.getByRole('slider')).toBeInTheDocument();

    await resize(NARROW);
    // Queried AFTER the crossing: this is the control the remount built, and a
    // different node from the one the slider was opened from.
    const control = page.getByRole('button', { name: /set this sticker's opacity/i }).element();

    // Closes rather than opens — the helper is a toggle, and the close is the
    // whole point here. Read synchronously afterwards: a regression parks focus
    // somewhere absorbing that no matcher could catch leaving.
    openOpacity();

    expect(document.activeElement?.getAttribute('aria-label')).toBe("Set this sticker's opacity");
    // Identity, not just the label: the assertion above is the legible one, this
    // is the one that cannot be satisfied by some other element carrying the
    // same name, and it pins that focus went to the control the crossing BUILT
    // rather than the detached one it replaced.
    expect(document.activeElement).toBe(control);
    // The control it returned to is the newly mounted one, not a detached node
    // left over from the layout it was opened in.
    expect(document.body.contains(document.activeElement)).toBe(true);
  });

  test('leaves a closed slider closed across the same crossing', async () => {
    // Without this, the case above would also pass against a popover wedged
    // permanently open.
    const { resize } = await renderDraft(WIDE);
    await expect.element(page.getByRole('button', { name: 'Place' })).toBeInTheDocument();
    expect(sliders()).toBe(0);

    await resize(NARROW);

    expect(sliders()).toBe(0);
  });
});
