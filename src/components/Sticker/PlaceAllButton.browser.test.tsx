import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
import type * as Notifications from '~/utils/notifications';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { PlaceAllButton } from '~/components/Sticker/PlaceAllButton';
import type { CreateStickerPlacementInput } from '~/server/schema/placement.schema';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

const { sent, handlers, errors, onSend } = vi.hoisted(() => ({
  sent: [] as CreateStickerPlacementInput[],
  // Runs as each placement is sent, so a test can change the drafts mid-run.
  onSend: { current: null as null | (() => void) },
  // Every handler the button was rendered with, so a test can press one from an earlier render:
  // the Buzz purchase modal calls the handler it was given, after the drafts may have changed.
  handlers: [] as (() => void)[],
  errors: [] as string[],
}));

vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({
    label,
    buzzAmount,
    onPerformTransaction,
  }: {
    label: string;
    buzzAmount: number;
    onPerformTransaction: () => void;
  }) => {
    handlers.push(onPerformTransaction);
    return (
      <button type="button" data-amount={buzzAmount} onClick={onPerformTransaction}>
        {label}
      </button>
    );
  },
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: ({ title }: { title: string }) => errors.push(title),
  showSuccessNotification: () => undefined,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'placement.createSticker': {
      useMutation: () => ({
        mutateAsync: async (input: CreateStickerPlacementInput) => {
          sent.push(input);
          onSend.current?.();
          return { status: 'approved' };
        },
      }),
    },
  }),
}));

const PRICE = 5;
const input = (cosmeticId: number) =>
  ({
    imageId: 1,
    free: false,
    data: { cosmeticId, x: 0.5, y: 0.5, scale: 0.2, rotation: 0, flip: false, opacity: 1 },
  } as CreateStickerPlacementInput);

/** Drafts a, b, c; `free` names the one holding the free placement. */
const seed = (ready: string[], free?: string) =>
  useStickerPlacementDraftStore.setState({
    drafts: ['a', 'b', 'c'].map((id) => ({ id } as StickerDraft)),
    readyPlacements: Object.fromEntries(
      ready.map((id, i) => [id, { free: id === free, input: () => input(i + 1) }])
    ),
    placingAll: false,
  });

const button = () => page.getByRole('button', { name: /^Place all/ });

beforeEach(() => {
  sent.length = 0;
  handlers.length = 0;
  errors.length = 0;
  onSend.current = null;
});

describe('Place all', () => {
  test('asks for the paid drafts only: the free one costs nothing', async () => {
    seed(['a', 'b', 'c'], 'a');
    renderWithProviders(<PlaceAllButton price={PRICE} />);

    await expect.element(button()).toHaveTextContent('Place all 3');
    await expect.element(button()).toHaveAttribute('data-amount', String(2 * PRICE));
  });

  test('is not offered for a single ready draft', async () => {
    seed(['a']);
    renderWithProviders(
      <>
        <span>rendered</span>
        <PlaceAllButton price={PRICE} />
      </>
    );
    await expect.element(page.getByText('rendered')).toBeInTheDocument();
    expect(button().elements()).toHaveLength(0);
  });

  test('is not offered when the creator has set no price', async () => {
    seed(['a', 'b']);
    renderWithProviders(
      <>
        <span>rendered</span>
        <PlaceAllButton price={null} />
      </>
    );
    await expect.element(page.getByText('rendered')).toBeInTheDocument();
    expect(button().elements()).toHaveLength(0);
  });

  test('is offered on a space priced at 0, for nothing', async () => {
    seed(['a', 'b']);
    renderWithProviders(<PlaceAllButton price={0} />);
    await expect.element(button()).toHaveAttribute('data-amount', '0');
  });

  test('places each ready draft in creation order with what it registered', async () => {
    seed(['a', 'c']);
    renderWithProviders(<PlaceAllButton price={PRICE} />);

    await button().click();

    await expect.poll(() => sent.map((s) => s.data.cosmeticId)).toEqual([1, 2]);
    expect(useStickerPlacementDraftStore.getState().drafts.map((d) => d.id)).toEqual(['b']);
    await expect.poll(() => useStickerPlacementDraftStore.getState().placingAll).toBe(false);
  });

  test('places nothing when the drafts cost more by the time it runs', async () => {
    seed(['a', 'b'], 'a');
    renderWithProviders(<PlaceAllButton price={PRICE} />);
    await expect.element(button()).toHaveAttribute('data-amount', String(PRICE));
    const pressedEarlier = handlers[0];

    seed(['a', 'b', 'c'], 'a');
    pressedEarlier();

    await expect.poll(() => errors).toEqual(['Your stickers changed']);
    expect(sent).toHaveLength(0);
  });

  test('places nothing when only one draft is ready by the time it runs', async () => {
    seed(['a', 'b']);
    renderWithProviders(<PlaceAllButton price={PRICE} />);
    await expect.element(button()).toHaveTextContent('Place all 2');
    const pressedEarlier = handlers[0];

    seed(['a']);
    pressedEarlier();

    await expect.poll(() => errors).toEqual(['Your stickers changed']);
    expect(sent).toHaveLength(0);
  });

  test('skips a draft removed while the run is going', async () => {
    seed(['a', 'b', 'c']);
    onSend.current = () => {
      onSend.current = null;
      const { drafts } = useStickerPlacementDraftStore.getState();
      useStickerPlacementDraftStore.setState({ drafts: drafts.filter((d) => d.id !== 'c') });
    };
    renderWithProviders(<PlaceAllButton price={PRICE} />);

    await button().click();

    await expect.poll(() => useStickerPlacementDraftStore.getState().placingAll).toBe(false);
    expect(sent.map((s) => s.data.cosmeticId)).toEqual([1, 2]);
    expect(errors).toEqual([]);
  });

  test('does not place a draft that stopped being ready before it runs', async () => {
    seed(['a', 'b', 'c']);
    renderWithProviders(<PlaceAllButton price={PRICE} />);
    await expect.element(button()).toHaveTextContent('Place all 3');
    const pressedEarlier = handlers[0];

    seed(['a', 'c']);
    pressedEarlier();

    await expect.poll(() => sent).toHaveLength(2);
    expect(sent.map((s) => s.data.cosmeticId)).toEqual([1, 2]);
  });
});
