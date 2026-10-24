import { fail, type RequestEvent } from '@sveltejs/kit';
import { removePlacement } from './user-actions.service';
import { canAccess } from './access';

/**
 * The removal path main added with the `StickerPlacement` reason (#3766). Only images carry that reason
 * (the main app's ReportModal, `availableFor`), so its one consumer is the image queue at
 * `/reports/image`. Delegated, not reimplemented: the service settles escrow, and that must have one
 * implementation.
 */
export const stickerPlacementActions = {
  removePlacement: async ({ request, locals }: RequestEvent) => {
    // Acting on reported content, not merely reading the queue — gated on its own path.
    if (!canAccess(locals.user, '/reports')) return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const placementId = Number(data.get('placementId'));
    if (!Number.isInteger(placementId) || placementId <= 0)
      return fail(400, { error: 'Invalid placement.' });

    const result = await removePlacement({ placementId, moderatorId: locals.user.id });
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true, placementRemoved: placementId };
  },
};
