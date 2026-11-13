// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { BankableBuzzMeter } from '~/components/Buzz/CreatorProgramV2/BankableBuzzMeter';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(props: Partial<React.ComponentProps<typeof BankableBuzzMeter>>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(BankableBuzzMeter, {
          balance: 0,
          bankableRemaining: 0,
          capRemaining: 0,
          onOpenInfo: () => undefined,
          ...props,
        })
      )
    );
  });
  return container;
}

function text(el: Element) {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('style').forEach((node) => node.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function legend(el: Element) {
  return [...el.querySelectorAll('li')].map((li) => text(li));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('BankableBuzzMeter', () => {
  it('splits the balance three ways and names the cap-limited amount', () => {
    const el = render({ balance: 250_000, bankableRemaining: 180_000, capRemaining: 100_000 });

    expect(el.querySelector('.mantine-Progress-root')).not.toBeNull();
    expect(legend(el)).toEqual([
      'Bankable this month100,000',
      'Over your cap80,000',
      'Not bankable70,000',
    ]);
    expect(text(el)).toContain(
      'You can bank up to 100,000 this month, the lower of your bankable Buzz and what is left of your cap.'
    );
  });

  it('leaves out segments with nothing in them', () => {
    const el = render({ balance: 90_000, bankableRemaining: 300_000, capRemaining: 400_000 });

    expect(legend(el)).toEqual(['Bankable this month90,000']);
  });

  it('shows no bar when the creator holds no Yellow or Green Buzz', () => {
    const el = render({ balance: 0, bankableRemaining: 50_000, capRemaining: 100_000 });

    expect(el.querySelector('.mantine-Progress-root')).toBeNull();
    expect(legend(el)).toEqual([]);
    expect(text(el)).toContain('You have no Yellow or Green Buzz to bank.');
  });

  it('says the cap is used up when bankable Buzz is held but the cap is not', () => {
    const el = render({ balance: 50_000, bankableRemaining: 50_000, capRemaining: 0 });

    expect(text(el)).toContain('You have reached your cap for this month.');
  });

  it('says nothing is bankable when the held Buzz is all non-bankable', () => {
    const el = render({ balance: 50_000, bankableRemaining: 0, capRemaining: 100_000 });

    expect(text(el)).toContain('None of your Buzz is bankable right now.');
  });

  it('asks for a membership, and splits by bankable only, when there is no cap', () => {
    const el = render({ balance: 100_000, bankableRemaining: 60_000, capRemaining: null });

    expect(legend(el)).toEqual(['Bankable60,000', 'Not bankable40,000']);
    expect(text(el)).toContain('An active membership is required to bank Buzz.');
    expect(text(el)).not.toContain('You can bank up to');
  });

  it('opens the explanation from the info button', () => {
    const onOpenInfo = vi.fn();
    const el = render({
      balance: 10_000,
      bankableRemaining: 10_000,
      capRemaining: 10_000,
      onOpenInfo,
    });

    act(() => {
      el.querySelector<HTMLButtonElement>('[aria-label="What counts as bankable"]')?.click();
    });

    expect(onOpenInfo).toHaveBeenCalledTimes(1);
  });
});
