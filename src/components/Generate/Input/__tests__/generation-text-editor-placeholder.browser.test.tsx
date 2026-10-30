import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import { GenerationTextEditor } from '~/components/Generate/Input/GenerationTextEditor';

/**
 * The placeholder is VISIBLE, not merely passed.
 *
 * Every call site already passed `placeholder` — "Your prompt goes here...", "What to avoid..."
 * — and the component set it as a `data-placeholder` attribute on the editor root, where
 * nothing read it: no rule in the tree matched that attribute. The prop was accepted and
 * silently dropped at six call sites, which is why the generator showed no hints.
 *
 * 🔴 ASSERTED THROUGH THE RENDERED TEXT, not the attribute. Checking `data-placeholder` is
 * exactly the mistake that let this ship: the attribute was present and correct the whole
 * time. Only the drawn text distinguishes a wired placeholder from a dropped one, and only a
 * real browser draws `::before { content: attr(...) }` — happy-dom computes no generated
 * content, so this cannot be a unit test.
 *
 * Both states are absorbing, so neither assertion races a disappearing frame: an empty editor
 * stays empty until typed into, and a typed one never spontaneously re-empties.
 */

function Harness({ placeholder }: { placeholder?: string }) {
  const [value, setValue] = useState('');
  return (
    <GenerationTextEditor
      value={value}
      onChange={setValue}
      label="Prompt"
      placeholder={placeholder}
      minRows={1}
    />
  );
}

/** The drawn placeholder, read off the empty paragraph's generated content. */
async function drawnPlaceholder(): Promise<string> {
  const p = page.elementLocator(document.body).element().querySelector('p.is-editor-empty');
  if (!p) return '';
  return window.getComputedStyle(p, '::before').content ?? '';
}

describe('GenerationTextEditor placeholder', () => {
  test('draws the placeholder while empty', async () => {
    renderWithProviders(<Harness placeholder="Your prompt goes here..." />);

    await expect.element(page.getByText('Prompt')).toBeInTheDocument();

    // The extension marks the empty paragraph; the style module draws it.
    const content = await drawnPlaceholder();
    expect(
      content,
      'the empty editor drew no generated content — the Placeholder extension or the style ' +
        'module is missing, which is the state this test exists to catch'
    ).toContain('Your prompt goes here');
  });

  test('falls back to the label when no placeholder is given', async () => {
    renderWithProviders(<Harness />);

    await expect.element(page.getByText('Prompt')).toBeInTheDocument();
    expect(await drawnPlaceholder()).toContain('Prompt');
  });

  // NEGATIVE CONTROL. Without it, a rule that drew the hint unconditionally — over the user's
  // own text — would satisfy both cases above.
  test('stops drawing it once the editor has text', async () => {
    renderWithProviders(<Harness placeholder="Your prompt goes here..." />);
    await expect.element(page.getByText('Prompt')).toBeInTheDocument();

    const editor = page.elementLocator(document.body).element().querySelector('.ProseMirror');
    expect(editor, 'no editor rendered').not.toBeNull();
    await userEvent.click(editor as Element);
    await userEvent.keyboard('a cat');

    expect(await drawnPlaceholder()).not.toContain('Your prompt goes here');
  });
});
