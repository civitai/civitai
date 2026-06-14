import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { OutputFormatInput } from '~/components/generation_v2/inputs/OutputFormatInput';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// OutputFormatInput is a pure value/onChange leaf (no tRPC/router): a Mantine
// Menu whose trigger (an UnstyledButton) shows the *selected* option's label,
// and whose Menu.Items emit onChange(value) on click. Lockable behavior pinned
// here: the trigger label reflects `value` (defaulting to 'JPEG' when unset),
// clicking a Menu.Item emits the right value, the `+offset Buzz` glyph renders
// only for offset>0, and the "Free for Members" line shows for png when
// isMember. Mantine v7 renders the dropdown in a PORTAL on document.body, so
// the options only exist after the trigger is clicked — but `page` queries the
// whole document so they're still findable post-open.
//
// `cleanup()` after each test (component-setup.tsx) keeps the document free of
// prior renders.
const options = [
  { label: 'JPEG', value: 'jpeg' },
  { label: 'PNG', value: 'png', offset: 5 },
];

describe('OutputFormatInput', () => {
  // The trigger is an aria-labelled button ("Output Format: <value>"); query by
  // the stable prefix so these never coincidentally match a future second button
  // (and don't break as the selected value changes the full name).
  const trigger = () => page.getByRole('button', { name: /Output Format/ });

  test('trigger shows the selected option\'s label', async () => {
    renderWithProviders(<OutputFormatInput value="png" options={options} onChange={vi.fn()} />);

    // Scope to the trigger (the menu is closed, but be explicit about intent).
    await expect.element(trigger().getByText('PNG')).toBeInTheDocument();
  });

  test('trigger falls back to JPEG when value is unset', async () => {
    // selected is undefined -> `selected?.label ?? 'JPEG'`. This must hold even
    // though no option is currently active.
    renderWithProviders(<OutputFormatInput value={undefined} options={options} onChange={vi.fn()} />);

    await expect.element(trigger().getByText('JPEG')).toBeInTheDocument();
  });

  test('trigger renders the selected option\'s own +Buzz offset glyph', async () => {
    // Distinct from FormatLabel inside the menu: the trigger has its OWN offset
    // span (`selected && offset>0`). value=png (offset 5) -> trigger shows +5,
    // without opening the dropdown.
    renderWithProviders(<OutputFormatInput value="png" options={options} onChange={vi.fn()} />);

    await expect.element(trigger().getByText('5')).toBeInTheDocument();
  });

  test('clicking a Menu.Item emits its value', async () => {
    const onChange = vi.fn();
    renderWithProviders(<OutputFormatInput value="jpeg" options={options} onChange={onChange} />);

    // Open the portal dropdown, then pick PNG (a Menu.Item -> menuitem role).
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole('menuitem', { name: /PNG/ }));

    expect(onChange).toHaveBeenCalledWith('png'); // emits value, not label
  });

  test('an option with a positive offset renders the +Buzz glyph in its item', async () => {
    // PNG has offset:5 -> FormatLabel renders a `+` and the offset number.
    // jpeg (offset undefined/0) must NOT. We assert the offset number shows in
    // the opened menu.
    renderWithProviders(<OutputFormatInput value="jpeg" options={options} onChange={vi.fn()} />);

    await userEvent.click(trigger());
    const png = page.getByRole('menuitem', { name: /PNG/ });
    await expect.element(png).toBeInTheDocument();
    await expect.element(png.getByText('5')).toBeInTheDocument();
  });

  test('isMember shows "Free for Members" on the png item only', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <OutputFormatInput value="jpeg" options={options} isMember onChange={onChange} />
    );

    await userEvent.click(trigger());

    // isFreeForMember = isMember && option.value === 'png' -> the line shows on
    // the png item and NOT on jpeg. Scope BOTH assertions to their menuitem so
    // each fails on its own intent (not a strict-mode multi-match).
    const png = page.getByRole('menuitem', { name: /PNG/ });
    const jpeg = page.getByRole('menuitem', { name: /JPEG/ });
    await expect.element(png.getByText('Free for Members')).toBeInTheDocument();
    await expect.element(jpeg.getByText('Free for Members')).not.toBeInTheDocument();
  });
});
