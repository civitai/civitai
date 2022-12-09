import { getAllPartnersHandler } from './../controllers/partner.controller';

import { router, publicProcedure } from '~/server/trpc';

export const partnerRouter = router({
  getAll: publicProcedure.query(getAllPartnersHandler),
});
