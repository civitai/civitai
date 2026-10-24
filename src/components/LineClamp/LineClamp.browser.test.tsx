// The harness loads no Mantine CSS, and without it `lineClamp` truncates nothing.
import '@mantine/core/styles.layer.css';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { LineClamp } from './LineClamp';

const LONG = 'roaring lion head with a vast cosmic purple mane '.repeat(20);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function Harness({
  initial,
  next,
  variant,
}: {
  initial: string;
  next: string;
  variant?: 'inline' | 'block';
}) {
  const [text, setText] = useState(initial);
  return (
    <div style={{ width: 300, whiteSpace: 'pre-line' }}>
      <button onClick={() => setText(next)}>change</button>
      <LineClamp lh={1.3} variant={variant}>
        {text}
      </LineClamp>
    </div>
  );
}

describe('LineClamp', () => {
  test('a truncated prompt offers Show more, and toggles back after Show less', async () => {
    await renderWithProviders(<Harness initial={LONG} next={LONG} />);

    await page.getByText('Show more').click();
    // Show less must survive the resize its own expansion causes.
    await nextFrame();
    await nextFrame();
    expect(page.getByText('Show less').query()).not.toBeNull();

    await page.getByText('Show less').click();
    await expect.element(page.getByText('Show more')).toBeVisible();
  });

  test('text that grows the box at the same width offers Show more', async () => {
    await renderWithProviders(<Harness initial="short" next={LONG} />);
    await expect.element(page.getByText('short')).toBeVisible();
    expect(page.getByText('Show more').query()).toBeNull();

    await page.getByRole('button', { name: 'change' }).click();
    await expect.element(page.getByText('Show more')).toBeVisible();
  });

  test('text that overflows without changing the box height offers Show more', async () => {
    // Three lines fill the clamp exactly, so a fourth changes no size the observer can see.
    await renderWithProviders(<Harness initial={'a\nb\nc'} next={'a\nb\nc\nd'} />);
    await expect.element(page.getByText(/^a\s*b\s*c$/)).toBeVisible();
    expect(page.getByText('Show more').query()).toBeNull();

    await page.getByRole('button', { name: 'change' }).click();
    await expect.element(page.getByText('Show more')).toBeVisible();
  });

  test('the block variant offers Show more once its text grows', async () => {
    await renderWithProviders(<Harness initial="short" next={LONG} variant="block" />);
    await expect.element(page.getByText('short')).toBeVisible();
    expect(page.getByText('Show more').query()).toBeNull();

    await page.getByRole('button', { name: 'change' }).click();
    await page.getByText('Show more').click();
    await expect.element(page.getByText('Show less')).toBeVisible();
  });
});
