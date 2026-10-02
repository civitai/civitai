// @vitest-environment happy-dom
import fs from 'fs';
import path from 'path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import { mobileMenuSheetZIndex } from '~/shared/constants/app-layout.constants';

// ClickUp 868m8byb2. The generator's sort control did nothing when tapped on a phone
// and worked in desktop-mode on the same device. The sheet WAS opening — at Mantine's
// default 200, behind the generation panel, which goes fullscreen at `z-[210]`.
//
// It looked lifted: `SelectMenu.module.scss` carried `.root { z-index: 400 }` and
// handed it over as `classNames.root`. Mantine's Drawer root is `position: static`
// and holds only custom properties, so that declaration could never do anything —
// the stacking is on `inner`/`overlay`, both reading `var(--mb-z-index)`, which only
// the `zIndex` PROP sets.
//
// So this reads the property Mantine actually emits rather than the prop we passed:
// a fix re-applied as a class is exactly the revert this has to fail on, and a prop
// spy would pass against it.

function emittedZIndex() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        null,
        createElement(
          MobileMenuDrawer,
          { opened: true, onClose: () => undefined },
          createElement('div', null, 'sort options')
        )
      )
    );
  });

  const carrier = Array.from(document.querySelectorAll<HTMLElement>('[style]')).find((el) =>
    el.style.getPropertyValue('--mb-z-index')
  );
  expect(
    carrier,
    'no element carries --mb-z-index — Mantine changed how a Drawer stacks'
  ).toBeTruthy();
  return Number(carrier!.style.getPropertyValue('--mb-z-index'));
}

/** The fullscreen generation panel's z-index, which is a Tailwind arbitrary value. */
function generationPanelFullscreenZIndex() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../ImageGeneration/GenerationSidebar.tsx'),
    'utf8'
  );
  const match = src.match(/fullScreen && '([^']*\bz-\[(\d+)\])/);
  expect(
    match,
    'GenerationSidebar no longer sets a `z-[n]` on its fullScreen branch — re-point this test at ' +
      'whatever now stacks the panel, or the sheet is being compared against nothing'
  ).toBeTruthy();
  return Number(match![2]);
}

describe('MobileMenuDrawer stacking', () => {
  it('emits a z-index that clears the fullscreen generation panel', () => {
    expect(emittedZIndex()).toBeGreaterThan(generationPanelFullscreenZIndex());
  });

  it('emits the shared sheet z-index, not Mantine default', () => {
    // 200 is Mantine's `modal` elevation. Naming it keeps the failure legible: the
    // revert reads `expected 200 to be 400`, not `expected undefined`.
    expect(emittedZIndex()).toBe(mobileMenuSheetZIndex);
    expect(mobileMenuSheetZIndex).not.toBe(200);
  });
});
