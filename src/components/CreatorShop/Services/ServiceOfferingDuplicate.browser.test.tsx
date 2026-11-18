import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { ServiceOfferingFormModal } from './ServiceOfferingFormModal';
import { NsfwLevel } from '~/server/common/enums';
import { SERVICE_OFFERING_DEFAULT_RATING } from '~/shared/constants/creator-service.constants';

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/libs/form/components/SimpleImageUpload', () => ({ SimpleImageUpload: () => null }));
vi.mock('~/components/CreatorShop/Services/creator-service.util', () => ({
  useMutateMyServices: () => ({ upsert: { mutateAsync, isPending: false } }),
}));

const original = {
  id: 5,
  title: 'Character sheet (SFW)',
  description: 'Front, side and back views of your character.',
  price: 2500,
  deliveryDays: 7,
  revisionsIncluded: 3,
  maxOpenDeals: 4,
  previewKind: 'SampleOutputs',
  declaredNsfwLevel: NsfwLevel.R,
  maxNsfwLevel: NsfwLevel.R,
  status: 'Active',
  termsAffirmed: true,
  coverImage: { id: 9, url: 'cover-uuid', nsfwLevel: NsfwLevel.PG, metadata: null },
};

beforeEach(() => mutateAsync.mockReset().mockResolvedValue(undefined));

describe('duplicating a service', () => {
  test("prefills the original's wording and terms, but not its cover, rating or affirmation", async () => {
    renderWithProviders(<ServiceOfferingFormModal copyOf={original as never} />);

    await expect.element(page.getByText('Duplicate service')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Title')).toHaveValue('Character sheet (SFW) (copy)');
    await page.getByRole('button', { name: 'Save draft' }).click();

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const [saved] = mutateAsync.mock.calls[0];
    expect(saved).toMatchObject({
      id: undefined,
      publish: false,
      title: 'Character sheet (SFW) (copy)',
      description: original.description,
      price: 2500,
      deliveryDays: 7,
      revisionsIncluded: 3,
      maxOpenDeals: 4,
      previewKind: 'SampleOutputs',
      declaredNsfwLevel: SERVICE_OFFERING_DEFAULT_RATING,
      coverImage: null,
    });
  });

  test('asks the seller to affirm the terms again before publishing the copy', async () => {
    renderWithProviders(<ServiceOfferingFormModal copyOf={original as never} />);
    await expect.element(page.getByRole('button', { name: 'Publish service' })).toBeDisabled();
  });

  test('keeps a long title within the limit', async () => {
    renderWithProviders(
      <ServiceOfferingFormModal copyOf={{ ...original, title: 'x'.repeat(100) } as never} />
    );
    await expect.element(page.getByLabelText('Title')).toHaveValue(`${'x'.repeat(93)} (copy)`);
  });
});
