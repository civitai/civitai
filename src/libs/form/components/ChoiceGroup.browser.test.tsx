import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { ChoiceGroup } from '~/libs/form/components/ChoiceGroup';

const versions = ['Draft', 'Standard', 'Krea', 'Pro', 'Ultra'];

/** The number of tiles on each row, top to bottom, read from where each one is drawn. */
const rows = () => {
  const tops = Array.from(document.querySelectorAll('[role="radio"]')).map(
    (tile) => tile.getBoundingClientRect().top
  );
  return [...new Set(tops)].map((top) => tops.filter((t) => t === top).length);
};

// The suite runs without Tailwind (see component-setup), so the two utilities the layout rests on
// are restated; the column count under test is ChoiceGroup's own inline style.
const tailwind = String.raw`.grid { display: grid } .gap-1\.5 { gap: 6px }`;

const renderAt = (width: number, dynamicColumns?: number, data = versions) =>
  renderWithProviders(
    <div data-testid="frame" style={{ width }}>
      <style>{tailwind}</style>
      <ChoiceGroup value={data[0]} onChange={vi.fn()} data={data} dynamicColumns={dynamicColumns} />
    </div>
  );

const ready = () => expect.element(page.getByRole('radio', { name: 'Ultra' })).toBeInTheDocument();

describe('ChoiceGroup', () => {
  test('by default, five options wrap after four', async () => {
    await renderAt(400);
    await ready();
    expect(rows()).toEqual([4, 1]);
  });

  test('with dynamicColumns, five options share one row while every label fits', async () => {
    await renderAt(400, 6);
    await ready();
    expect(rows()).toEqual([5]);
  });

  test('dynamicColumns caps the row even when there is room for more', async () => {
    await renderAt(800, 3);
    await ready();
    expect(rows()).toEqual([3, 2]);
  });

  test('a row too narrow for its labels wraps into even rows, not a lone tile', async () => {
    await renderAt(300, 6, [...versions, 'Max']);
    await ready();
    expect(rows()).toEqual([3, 3]);
  });

  test('narrowing the row re-fits it', async () => {
    await renderAt(400, 6);
    await ready();
    expect(rows()).toEqual([5]);

    page.getByTestId('frame').element().setAttribute('style', 'width: 200px');
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(1));
  });
});
