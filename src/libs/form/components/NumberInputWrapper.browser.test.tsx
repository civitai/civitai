import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const { useState } = await import('react');
const { NumberInputWrapper } = await import('~/libs/form/components/NumberInputWrapper');

function Controlled({
  clampToMax,
  onValue,
}: {
  clampToMax?: boolean;
  onValue: (v?: number) => void;
}) {
  const [value, setValue] = useState<number | undefined>(undefined);
  return (
    <NumberInputWrapper
      aria-label="amount"
      value={value}
      max={1000}
      clampToMax={clampToMax}
      onChange={(next) => {
        onValue(next);
        setValue(next);
      }}
    />
  );
}

const input = () => document.querySelector<HTMLInputElement>('input[aria-label="amount"]')!;

describe('NumberInputWrapper — clampToMax', () => {
  test('sets a value typed past the maximum to the maximum', async () => {
    const onValue = vi.fn();
    renderWithProviders(<Controlled clampToMax onValue={onValue} />);
    await vi.waitFor(() => expect(input()).toBeTruthy());

    await userEvent.type(input(), '99999');

    expect(onValue).toHaveBeenLastCalledWith(1000);
    await vi.waitFor(() => expect(input().value.replace(/,/g, '')).toBe('1000'));
  });

  test('leaves the value alone without it, as before', async () => {
    const onValue = vi.fn();
    renderWithProviders(<Controlled onValue={onValue} />);
    await vi.waitFor(() => expect(input()).toBeTruthy());

    await userEvent.type(input(), '99999');

    expect(onValue).toHaveBeenLastCalledWith(99999);
  });
});
