import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getGalleryImagesHandler,
  getGalleryImageDetailHandler,
  getModelVersionImagesHandler,
  getReviewImagesHandler,
} from './../controllers/image.controller';
import {
  getModelVersionImageSchema,
  getReviewImagesSchema,
  getGalleryImageSchema,
} from './../schema/image.schema';
import { publicProcedure, router } from '~/server/trpc';

export const imageRouter = router({
  getModelVersionImages: publicProcedure
    .input(getModelVersionImageSchema)
    .query(getModelVersionImagesHandler),
  getReviewImages: publicProcedure.input(getReviewImagesSchema).query(getReviewImagesHandler),
  getGalleryImagesInfinite: publicProcedure
    .input(getGalleryImageSchema)
    .query(getGalleryImagesHandler),
  getGalleryImageDetail: publicProcedure.input(getByIdSchema).query(getGalleryImageDetailHandler),
});
