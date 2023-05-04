import { router, publicProcedure } from '~/server/trpc';
import { getAllPartners } from '~/server/services/partner.service';

export const partnerRouter = router({
  getAll: publicProcedure.query(() => getAllPartners()),
});
