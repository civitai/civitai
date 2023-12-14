import { z } from 'zod';

export namespace Ncmec {
  export const statusResponseSchema = z.object({
    reportResponse: z.object({
      responseCode: z.coerce.number(),
      responseDescription: z.coerce.string(),
    }),
  });

  export const reportResponseSchema = z.object({
    reportResponse: z.object({
      responseCode: z.coerce.number(),
      responseDescription: z.coerce.string(),
      reportId: z.coerce.number(),
    }),
  });

  export const uploadResponseSchema = z.object({
    reportResponse: z.object({
      responseCode: z.coerce.number(),
      responseDescription: z.coerce.string(),
      reportId: z.coerce.number(),
      fileId: z.coerce.string(),
      hash: z.coerce.string(),
    }),
  });

  export type FileAnnotationsInput = z.infer<typeof fileAnnotationsSchema>;
  export const fileAnnotationsSchema = z.object({
    animeDrawingVirtualHentai: z.boolean().optional(),
    physicalHarm: z.boolean().optional(),
    violenceGore: z.boolean().optional(),
    bestiality: z.boolean().optional(),
    infant: z.boolean().optional(),
    generativeAi: z.boolean().default(true),
  });

  export type FileDetails = {
    originalFileName?: string;
    locationOfFile?: string;
    fileAnnotations?: FileAnnotationsInput;
    additionalInfo?: string;
  };
}
