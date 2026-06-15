import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { SelectInput } from '~/components/generation_v2/inputs/SelectInput';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// SelectInput is a pure value/onChange leaf (no tRPC/router) wrapping a Mantine
// Select, plus an optional row of `presets` buttons rendered in the label.
// The lockable behavior worth pinning: the `data`/`options` aliasing, the
// `onChange` truthy-guard (`if (newValue) onChange?.(newValue)`), the preset
// buttons emitting onChange, and `allowDeselect={false}` (re-picking the
// current value must NOT clear it). Mantine v7's Select is a text input that
// reveals its option list (in a portal) on open — queries below confirmed
// against the real rendered DOM.
//
// Queries go through the global `page` (whole-document); `cleanup()` after each
// test (component-setup.tsx) keeps the document free of prior renders.
const data = [
  { label: 'First', value: 'a' },
  { label: 'Second', value: 'b' },
  { label: 'Third', value: 'c' },
];

describe('SelectInput', () => {
  test('renders the selected value\'s label in the input', async () => {
    renderWithProviders(<SelectInput value="b" data={data} onChange={vi.fn()} />);

    // Mantine v7 Select is a (readonly) text input; the displayed value is the
    // matching option's *label*, not its `value`.
    await expect.element(page.getByRole('textbox')).toHaveValue('Second');
  });

  test('picking an option from the dropdown emits its value', async () => {
    const onChange = vi.fn();
    renderWithProviders(<SelectInput value="a" data={data} onChange={onChange} />);

    await userEvent.click(page.getByRole('textbox'));
    // Options live in a portal-rendered listbox; getByRole('option') finds them.
    await userEvent.click(page.getByRole('option', { name: 'Third' }));

    expect(onChange).toHaveBeenCalledWith('c'); // emits value, not label
  });

  test('`options` is aliased to `data` when `data` is absent', async () => {
    // If the alias breaks, no options render and the click below can't find one.
    const onChange = vi.fn();
    renderWithProviders(<SelectInput value="a" options={data} onChange={onChange} />);

    await userEvent.click(page.getByRole('textbox'));
    await userEvent.click(page.getByRole('option', { name: 'Second' }));

    expect(onChange).toHaveBeenCalledWith('b');
  });

  test('clicking a preset button emits that preset value', async () => {
    const presets = [
      { label: 'Square', value: 'a' },
      { label: 'Portrait', value: 'b' },
    ];
    const onChange = vi.fn();
    renderWithProviders(
      <SelectInput value="a" data={data} presets={presets} onChange={onChange} label="Size" />
    );

    await userEvent.click(page.getByRole('button', { name: 'Portrait' }));

    expect(onChange).toHaveBeenCalledWith('b');
  });

  test('re-selecting the current value never emits onChange', async () => {
    // User-facing invariant: re-picking the already-selected option must not
    // fire onChange (no spurious change / no clear). TWO mechanisms enforce this
    // and mask each other, so neither is independently isolable through the
    // controlled public API: `allowDeselect={false}` suppresses the deselect,
    // and the `if (newValue) onChange?.(newValue)` truthy-guard swallows the
    // null Mantine would otherwise emit. This test pins the COMBINED invariant
    // (defense-in-depth) — removing either one alone still keeps it green; only
    // removing both surfaces a null emission. Accept that as the coverage limit.
    const onChange = vi.fn();
    renderWithProviders(<SelectInput value="b" data={data} onChange={onChange} />);

    await userEvent.click(page.getByRole('textbox'));
    await userEvent.click(page.getByRole('option', { name: 'Second' }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
