import {
  getModelVersionImagesHandler,
  getReviewImagesHandler,
} from './../controllers/image.controller';
import { getModelVersionImageSchema, getReviewImagesSchema } from './../schema/image.schema';
import { publicProcedure, router } from '~/server/trpc';

export const imageRouter = router({
  getModelVersionImages: publicProcedure
    .input(getModelVersionImageSchema)
    .query(getModelVersionImagesHandler),
  getReviewImages: publicProcedure.input(getReviewImagesSchema).query(getReviewImagesHandler),
});
