import { Drawer, Modal } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { describe, expect, test } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The `@layer mantine` rules in `src/styles/globals.css` pay the display-cutout
 * insets for EVERY Drawer (31 call sites) and every `fullScreen` Modal (17) by
 * selecting Mantine's own slots. This file is the only thing that checks those
 * selectors match anything.
 *
 * 🔴 WHY THIS IS NOT PARANOIA. The classes Mantine actually puts in the DOM are
 * content hashes (`.m_b8a05bbd`, `.m_60c222c7`). The stable
 * `mantine-<Component>-<slot>` names exist only because `MantineProvider`
 * defaults to `withStaticClasses: true` with `classNamesPrefix: "mantine"`, and
 * this app overrides neither. That is a node_modules default, not an API anyone
 * here controls: a Mantine upgrade that flips it, renames a slot, or drops
 * `data-full-screen` costs nothing at build time, breaks no type, fails no
 * other test, and silently leaves ~48 surfaces unpaid at the viewport edge on
 * every notched device. A CSS rule whose selector matches nothing is not an
 * error in any tool — it is just a rule that does nothing.
 *
 * Measured here, real Chromium, @mantine/core 7.17.8 — the shape these rules
 * are written against, recorded because the next person should not have to
 * re-derive it from node_modules:
 *
 *   DIV      .m_f11b401e .mantine-Drawer-root         [data-full-screen] on the
 *   DIV      .mantine-Drawer-overlay                   Modal root and content,
 *   DIV      .m_60c222c7 .m_31cd769a .mantine-Drawer-inner    absent on Drawer
 *   SECTION  .m_fd1ab0aa .m_b8a05bbd .mantine-Drawer-content
 *   HEADER   .mantine-Drawer-header
 *   DIV      .m_5df29311 .mantine-Drawer-body
 *
 * 🔴 `content` IS A <section>, NOT A <div>. Worth stating because the obvious
 * hand-check — dumping the div tree — omits exactly the element the drawer and
 * fullScreen-modal rules both pay on, and reads as "the class is not emitted".
 *
 * 🔴 WHAT THIS CANNOT SEE. `test/component-setup.tsx` injects only the `:root`
 * custom properties, NOT the app cascade, so `globals.css`'s rules have no
 * presence in this document and a computed-padding assertion here would read
 * `0px` whether the rule is right, wrong, or absent — a probe wired to nothing.
 * So this pins the half that IS observable: that the selectors those rules are
 * written against describe real elements. Whether the padding then clears a
 * physical home indicator is a device question no test in this repo answers.
 *
 * 🔴 RED-AT-BASE: these are INVARIANT GUARDS on a library contract, not
 * regression coverage — they pass at d15e02d0d9 too, because Mantine emitted
 * these classes before this change as well. They are counted as neither. Their
 * killing mutation is upstream (a Mantine version bump), which is exactly the
 * change no reviewer of this repo would think to check.
 */

/**
 * Mantine mounts a Drawer/Modal through a portal behind a `Transition`, so it is
 * NOT in the DOM when `render` returns. Polling rather than a fixed sleep, and
 * RETURNING the element so a caller cannot accidentally assert against an
 * unmounted tree.
 *
 * 🔴 This is what makes the absence assertion in the third test meaningful. Its
 * first draft asserted `.mantine-Modal-content[data-full-screen]` was null
 * immediately after `render` — which was true, and would have stayed true if
 * Mantine had stopped rendering modals altogether. Establishing presence first
 * is the positive control for the absence.
 */
async function portalled(selector: string): Promise<Element> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const el = document.body.querySelector(selector);
    if (el) return el;
    if (Date.now() > deadline)
      throw new Error(
        `\`${selector}\` never appeared in <body> within 5s. Mantine mounts these through a ` +
          'portal, so this is either a genuinely missing slot class — every rule in the ' +
          '`@layer mantine` block of globals.css that uses it is now inert — or the component ' +
          'failed to open at all.'
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the Mantine slot selectors globals.css pays on describe real elements', () => {
  test('a Drawer emits the stable `inner` and `content` slot classes', async () => {
    renderWithProviders(
      <Drawer opened onClose={() => undefined} position="bottom" title="probe">
        probe body
      </Drawer>
    );

    // `.mantine-Drawer-inner` is the `position: fixed` box globals.css shrinks
    // from the top, so a full-height drawer clears the status bar while a
    // partial-height bottom sheet is left where it was.
    await portalled('.mantine-Drawer-inner');
    // `.mantine-Drawer-content` carries the bottom and left/right insets for all
    // 31 drawers. Chosen over `body` precisely because ~20 call sites set
    // `body` padding inline, which outranks a stylesheet.
    await portalled('.mantine-Drawer-content');
  });

  test('a fullScreen Modal emits `content` carrying `data-full-screen`', async () => {
    renderWithProviders(
      <Modal opened onClose={() => undefined} fullScreen title="probe">
        probe body
      </Modal>
    );

    // Both halves are load-bearing: the class, and the attribute the
    // non-fullScreen rule uses to EXCLUDE this case.
    await portalled('.mantine-Modal-content[data-full-screen]');
  });

  /**
   * `@mantine/notifications` is the one seam rule that BRANCHES rather than
   * applying unconditionally, so it needs two facts to be true, not one: the
   * static class, and `data-position` on each container. Both are load-bearing
   * — `Notifications` renders all six position containers and a single `style`
   * prop is spread onto every one, which is exactly why the payment cannot be
   * done at the call site and has to read the attribute.
   *
   * The `-center` variants are asserted TOO, and asserted as the case the
   * inline rules must NOT match: they are placed with `left: 50%` and a
   * transform, so they have no inline edge to pay and an `[data-position$=…]`
   * that caught them would shove them off-centre.
   */
  test('every Notifications container emits the static class AND its data-position', async () => {
    renderWithProviders(<Notifications />);

    await portalled('.mantine-Notifications-root');
    for (const position of [
      'top-center',
      'top-left',
      'top-right',
      'bottom-right',
      'bottom-left',
      'bottom-center',
    ]) {
      await portalled(`.mantine-Notifications-root[data-position='${position}']`);
    }

    // The branch the globals.css rules actually make, read back off the real
    // DOM rather than assumed from the attribute values: exactly four of the
    // six containers have an inline edge to pay, and the two centred ones are
    // not among them.
    const inlineEdged = document.body.querySelectorAll(
      ".mantine-Notifications-root[data-position$='-left'], " +
        ".mantine-Notifications-root[data-position$='-right']"
    );
    expect(
      inlineEdged,
      'the `[data-position$="-left"] / $="-right"` selectors in globals.css no longer select ' +
        'exactly the four corner containers. If they now catch `top-center` / `bottom-center`, ' +
        'those are placed by `left: 50%` + a transform and an inline margin shoves them ' +
        'off-centre; if they catch fewer, a corner container pays nothing in landscape.'
    ).toHaveLength(4);
  });

  test('a plain Modal emits `inner`, and its root carries NO `data-full-screen`', async () => {
    renderWithProviders(
      <Modal opened onClose={() => undefined} title="probe">
        probe body
      </Modal>
    );

    // Presence first — this is the positive control for the absence below.
    await portalled('.mantine-Modal-root:not([data-full-screen]) .mantine-Modal-inner');

    expect(
      document.body.querySelector('.mantine-Modal-content[data-full-screen]'),
      'a modal rendered WITHOUT `fullScreen` still carries `data-full-screen`, so the two modal ' +
        'rules in globals.css no longer describe disjoint sets — the fullScreen rule is padding ' +
        'every dialog in the app, and the `:not()` on the other one excludes all of them.'
    ).toBeNull();
  });
});
