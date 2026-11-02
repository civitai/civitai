/**
 * The seller's own Shop services card at ~300px: the footer buttons must stay inside the card.
 * `Group wrap="nowrap"` on the footer let "Manage" + "Open deal (N)" run past the card edge.
 * Needs the real cascade (Mantine `Group` is `display: block` without it), hence `geometry`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { box, cascadeEvidence, renderAtViewport } from '../../../../test/geometry-setup';

const SELLER = 9;

vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => ({ id: SELLER }),
}));
vi.mock('~/components/CreatorShop/Services/creator-service.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryShopServices: () => ({
    offerings: [
      {
        id: 42,
        title: 'Portrait commission',
        description: 'One portrait.',
        price: 500,
        deliveryDays: 5,
        revisionsIncluded: 1,
        maxNsfwLevel: 2,
        slotsOpen: 3,
      },
    ],
    isLoading: false,
  }),
}));
vi.mock('~/components/CreatorShop/Services/deals/deal.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMyServiceDeals: () => ({
    deals: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, offering: { id: 42 } })),
    hasNextPage: false,
    hiddenOffDomain: 0,
  }),
}));
vi.mock('~/components/CreatorShop/Services/deals/ServiceRequestModal', () => ({
  ServiceRequestModal: () => null,
}));
vi.mock('~/hooks/useDomainColor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDomainColor: () => 'green',
}));

const { ServicesSection } = await import('~/components/CreatorShop/Storefront/ServicesSection');

afterEach(cleanup);

async function renderCard(containerWidth: number, viewportWidth: number) {
  await renderAtViewport(
    <div style={{ width: containerWidth }}>
      <ServicesSection ownerUserId={SELLER} username="seller" shopPublished />
    </div>,
    { width: viewportWidth, height: 900 }
  );
  const cascade = cascadeEvidence();
  expect(cascade.ruleCount, 'the app cascade did not load').toBeGreaterThan(1000);
  const card = document.querySelector('.mantine-Paper-root') as HTMLElement;
  expect(card, 'offering card not rendered').not.toBeNull();
  const buttons = [...card.querySelectorAll('a')].filter((a) =>
    /Manage|Open deal/.test(a.textContent ?? '')
  );
  expect(buttons.map((b) => b.textContent)).toEqual(['Manage', 'Open deal (12)']);
  return { card, buttons };
}

describe("seller's own services card footer", () => {
  test.each([
    [300, 390],
    [280, 390],
    [300, 1440],
    [900, 1440],
  ])(
    'buttons stay inside the card in a %ipx container (viewport %ipx)',
    async (width, viewport) => {
      const { card, buttons } = await renderCard(width, viewport);
      const cardBox = box(card);
      for (const b of buttons) {
        const r = box(b);
        expect(r.right, `"${b.textContent}" runs past the card edge`).toBeLessThanOrEqual(
          cardBox.right
        );
        expect(r.left).toBeGreaterThanOrEqual(cardBox.left);
      }
    }
  );
});
