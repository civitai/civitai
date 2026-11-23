import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { OffDomainTrainingDataNotice } from '~/components/Model/ModelVersions/OffDomainTrainingDataNotice';

const HREF = '//civitai.red/models/1/some-model?modelVersionId=10';

describe('OffDomainTrainingDataNotice', () => {
  test('links an off-domain dataset to the page on civitai.red', async () => {
    renderWithProviders(<OffDomainTrainingDataNotice stub={{ offDomain: true }} href={HREF} />);
    const link = page.getByRole('link', { name: 'See it on civitai.red' });
    await expect.element(link).toBeVisible();
    // The control for the empty-state test below, which queries this id.
    await expect.element(page.getByTestId('off-domain-training-data')).toBeVisible();
    expect(link.element().getAttribute('href')).toBe(HREF);
  });

  test('renders nothing without an off-domain dataset', async () => {
    renderWithProviders(<OffDomainTrainingDataNotice stub={null} href={HREF} />);
    await expect.element(page.getByTestId('off-domain-training-data')).not.toBeInTheDocument();
  });
});
