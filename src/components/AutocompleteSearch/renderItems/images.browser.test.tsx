import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// Stubbed: both need session and settings providers.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => <div data-testid="thumbnail" />,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

const { ImagesSearchItem } = await import('~/components/AutocompleteSearch/renderItems/images');

const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;

const hit = (nsfwLevel: number) =>
  ({
    id: 5,
    nsfwLevel,
    url: 'abc',
    type: 'image',
    hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    width: 4,
    height: 3,
    user: { id: 7, username: 'fox' },
  } as never);

const renderRow = (
  nsfwLevel: number,
  extra: { pickerRow?: boolean; viewerLevel?: number; blurLevels?: number } = {}
) => renderWithProviders(<ImagesSearchItem value="5" label="5" hit={hit(nsfwLevel)} {...extra} />);

const thumbnail = () => page.getByTestId('thumbnail').elements().length;

describe('ImagesSearchItem in the showcase picker', () => {
  test('shows the picture of a mature image the viewer can browse, with its rating', async () => {
    renderRow(R, { pickerRow: true, viewerLevel: PG | PG13 | R });

    await expect.element(page.getByText('R', { exact: true })).toBeInTheDocument();
    expect(thumbnail()).toBe(1);
  });

  test('blurs a mature image above the viewer’s level and still names its rating', async () => {
    renderRow(X, { pickerRow: true, viewerLevel: PG | PG13 });

    await expect.element(page.getByText('X', { exact: true })).toBeInTheDocument();
    expect(thumbnail()).toBe(0);
  });

  test('keeps a mature image blurred, with its rating, when the viewer chose to blur it', async () => {
    renderRow(R, { pickerRow: true, viewerLevel: PG | PG13 | R, blurLevels: R | X });

    await expect.element(page.getByText('R', { exact: true })).toBeInTheDocument();
    expect(thumbnail()).toBe(0);
  });

  test('a PG image carries no rating badge', async () => {
    renderRow(PG, { pickerRow: true, viewerLevel: PG | PG13 });

    await expect.element(page.getByText('fox')).toBeInTheDocument();
    expect(page.getByText('PG', { exact: true }).elements()).toHaveLength(0);
    expect(thumbnail()).toBe(1);
  });

  test('without the picker flag a mature image stays blurred and unlabelled', async () => {
    renderRow(R, { viewerLevel: PG | PG13 | R });

    await expect.element(page.getByText('fox')).toBeInTheDocument();
    expect(thumbnail()).toBe(0);
    expect(page.getByText('R', { exact: true }).elements()).toHaveLength(0);
  });
});
