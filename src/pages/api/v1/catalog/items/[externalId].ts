import { withAxiom } from '@civitai/next-axiom';

import { catalogEndpoint } from '~/server/services/blocks/app-sub-listing-catalog-auth';
import {
  upsertCatalogSubListing,
  withdrawCatalogSubListing,
} from '~/server/services/blocks/app-sub-listing.service';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

/**
 * PUT /api/v1/catalog/items/{externalId} publishes or edits one item under the off-site listing
 * linked to the calling OAuth client; DELETE withdraws it. Every check is in the service.
 * See docs/features/app-store-sub-listings.md → "Catalog sync".
 */
export const baseHandler = catalogEndpoint(['PUT', 'DELETE'], async (req, res, caller) => {
  const externalId = typeof req.query.externalId === 'string' ? req.query.externalId : '';
  if (req.method === 'DELETE') {
    res
      .status(200)
      .json(
        await withdrawCatalogSubListing({ parentListingId: caller.parentListingId, externalId })
      );
    return;
  }
  res.status(200).json(
    await upsertCatalogSubListing({
      parentListingId: caller.parentListingId,
      clientId: caller.clientId,
      externalId,
      body: req.body,
    })
  );
});

export default withAxiom(baseHandler);
