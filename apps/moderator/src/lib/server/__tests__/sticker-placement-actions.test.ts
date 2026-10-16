import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sticker-placement removal a `StickerPlacement` report carries — on `/reports/image`, the one
 * queue that shows those reports. Delegated to the service, which settles escrow.
 */

const removePlacement = vi.fn();
const canAccess = vi.fn(() => true);
vi.mock('../user-actions.service', () => ({ removePlacement }));
vi.mock('../access', () => ({ canAccess }));

const { stickerPlacementActions: actions } = await import('../sticker-placement-actions');

const MOD = { id: 7 };
/**
 * A REAL `FormData`, not a Map: `Map.get` gives `undefined` where `FormData.get` gives `null`, and
 * `Number()` maps those to NaN and 0 — opposite sides of `removePlacement`'s `Number.isInteger`.
 */
const event = (form: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(form)) data.append(key, value);
  return { request: { formData: async () => data }, locals: { user: MOD, grants: {} } } as never;
};
const failure = (result: unknown) => {
  const r = result as { status: number; data: { error: string } };
  return { status: r.status, error: r.data.error };
};

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockReturnValue(true);
});

describe('removePlacement action', () => {
  it('is gated on /reports even though the page load is not', async () => {
    canAccess.mockReturnValue(false);

    const result = await actions.removePlacement(event({ placementId: '5' }));

    expect(canAccess).toHaveBeenCalledWith(MOD, '/reports');
    expect(failure(result).status).toBe(403);
    expect(removePlacement).not.toHaveBeenCalled();
  });

  it('delegates to the service so escrow settles in one place', async () => {
    removePlacement.mockResolvedValue({ ok: true });

    const result = await actions.removePlacement(event({ placementId: '5' }));

    expect(removePlacement).toHaveBeenCalledWith({ placementId: 5, moderatorId: 7 });
    expect(result).toMatchObject({ success: true, placementRemoved: 5 });
  });

  it('rejects a non-positive placement id without reaching the service', async () => {
    const result = await actions.removePlacement(event({ placementId: '0' }));

    expect(failure(result).status).toBe(400);
    expect(removePlacement).not.toHaveBeenCalled();
  });

  it('rejects a missing placement id — absent reads as 0, not as NaN', async () => {
    const result = await actions.removePlacement(event());

    expect(failure(result).status).toBe(400);
    expect(removePlacement).not.toHaveBeenCalled();
  });

  it('surfaces an escrow failure rather than reporting the placement removed', async () => {
    // A refusal here is money that did not move.
    removePlacement.mockResolvedValue({ ok: false, error: 'Escrow already settled.' });

    const result = await actions.removePlacement(event({ placementId: '5' }));

    expect(failure(result)).toEqual({ status: 400, error: 'Escrow already settled.' });
  });
});
