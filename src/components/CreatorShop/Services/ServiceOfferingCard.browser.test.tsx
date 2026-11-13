import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@mantine/core/styles.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ServiceOfferingCard } from './ServiceOfferingCard';

vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));

// One paragraph: fits in 4 lines when wide, clamps once the container narrows.
const description =
  'Custom character portrait in your style, delivered with layered files. '.repeat(3);

const offering = {
  title: 'Portrait',
  description,
  price: 500,
  deliveryDays: 7,
  revisionsIncluded: 1,
  maxNsfwLevel: 1,
};

const showMore = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Show more');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ServiceOfferingCard', () => {
  test('Show more appears when the card narrows after mount', async () => {
    await page.viewport(1280, 900);
    renderWithProviders(
      <div id="holder" style={{ width: 900 }}>
        <ServiceOfferingCard offering={offering} />
      </div>
    );
    await sleep(300);
    expect(showMore()).toBeUndefined();

    document.getElementById('holder')!.style.width = '220px';
    await expect.poll(showMore, { timeout: 2000 }).toBeTruthy();
  });
});
