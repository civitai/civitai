import { withAxiom } from '@civitai/next-axiom';

import { catalogEndpoint } from '~/server/services/blocks/app-sub-listing-catalog-auth';
import { listCatalogSubListings } from '~/server/services/blocks/app-sub-listing.service';

/**
 * GET /api/v1/catalog/items?cursor= — every store item under the off-site listing linked to the
 * calling OAuth client, for its platform to diff against its own catalog.
 * See docs/features/app-store-sub-listings.md → "Catalog sync".
 */
export const baseHandler = catalogEndpoint(['GET'], async (req, res, caller) => {
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  res
    .status(200)
    .json(await listCatalogSubListings({ parentListingId: caller.parentListingId, cursor }));
});

export default withAxiom(baseHandler);
