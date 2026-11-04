import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { CreatableMultiSelect } from './MultiSelectWrapper';

const onSubmit = vi.fn();

function Harness({ maxValues, data }: { maxValues?: number; data?: string[] }) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <CreatableMultiSelect
        value={value}
        onChange={setValue}
        data={data}
        maxValues={maxValues}
        parsePaste
        placeholder="Trigger words"
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
      <button type="submit">Save</button>
    </form>
  );
}

const field = () => page.getByPlaceholder('Trigger words');
const value = () => JSON.parse(document.querySelector('[data-testid="value"]')!.textContent!);

describe('CreatableMultiSelect Enter', () => {
  test('adds typed entries split on commas, and does not submit the form', async () => {
    onSubmit.mockClear();
    renderWithProviders(<Harness />);
    await field().fill('monochrome, greyscale');
    await userEvent.keyboard('{Enter}');
    await expect.poll(value).toEqual(['monochrome', 'greyscale']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('drops empty entries from the split', async () => {
    renderWithProviders(<Harness />);
    await field().fill('a,, b,');
    await userEvent.keyboard('{Enter}');
    await expect.poll(value).toEqual(['a', 'b']);
  });

  test('keeps to maxValues', async () => {
    renderWithProviders(<Harness maxValues={1} />);
    await field().fill('a, b');
    await userEvent.keyboard('{Enter}');
    await expect.poll(value).toEqual(['a']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('empty search does nothing and does not submit', async () => {
    onSubmit.mockClear();
    renderWithProviders(<Harness />);
    await field().click();
    await userEvent.keyboard('{Enter}');
    expect(value()).toEqual([]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('a highlighted option wins over the typed text', async () => {
    renderWithProviders(<Harness data={['Master Chief', 'Cortana']} />);
    await field().fill('c');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect.poll(value).toHaveLength(1);
    expect(value()[0]).not.toBe('c');
  });

  test('Enter that confirms an IME composition adds nothing', async () => {
    onSubmit.mockClear();
    renderWithProviders(<Harness />);
    await field().fill('かんじ');
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Trigger words"]')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(value()).toEqual([]);
  });

  test('pasting still splits and respects maxValues', async () => {
    renderWithProviders(<Harness maxValues={2} />);
    await field().click();
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Trigger words"]')!;
    const data = new DataTransfer();
    data.setData('text', 'a,b,c');
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );
    await expect.poll(value).toEqual(['a', 'b']);
  });
});
