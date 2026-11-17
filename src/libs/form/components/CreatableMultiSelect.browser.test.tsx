import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
  beforeEach(() => onSubmit.mockClear());

  test('adds the typed text as one entry, commas included, and does not submit the form', async () => {
    renderWithProviders(<Harness />);
    await field().fill('monochrome, greyscale');
    await userEvent.keyboard('{Enter}');
    await expect.poll(value).toEqual(['monochrome, greyscale']);
    await expect.element(field()).toHaveValue('');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('trims the entry and keeps to maxValues', async () => {
    renderWithProviders(<Harness maxValues={1} />);
    await field().fill('  a, b  ');
    await userEvent.keyboard('{Enter}');
    await expect.poll(value).toEqual(['a, b']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('empty search does nothing and does not submit', async () => {
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
    await expect.poll(value).toEqual(['Master Chief']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Enter that confirms an IME composition adds nothing', async () => {
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
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(value()).toEqual([]);
  });

  test('pasting splits on commas and new lines, dropping empty and duplicate entries', async () => {
    renderWithProviders(<Harness />);
    await field().click();
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Trigger words"]')!;
    const data = new DataTransfer();
    data.setData('text', 'a,, b\na, ');
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );
    await expect.poll(value).toEqual(['a', 'b']);
  });

  test('pasting counts existing values toward maxValues', async () => {
    renderWithProviders(<Harness maxValues={2} />);
    await field().fill('x');
    await userEvent.keyboard('{Enter}');
    await expect.poll(value).toEqual(['x']);
    await field().click();
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Trigger words"]')!;
    const data = new DataTransfer();
    data.setData('text', 'a,b');
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );
    await expect.poll(value).toEqual(['x', 'a']);
  });
});
