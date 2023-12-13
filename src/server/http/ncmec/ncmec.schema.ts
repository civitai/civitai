import { z } from 'zod';

export namespace Ncmec {
  export const statusResponseSchema = z.object({
    reportResponse: z.object({
      responseCode: z.coerce.string(),
      responseDescription: z.coerce.string(),
    }),
  });

  export type ReportResponse = {
    responseCode: number;
    responseDescription: string;
    reportId: number;
  };

  export type UploadResponse = {
    responseCode: number;
    responseDescription: string;
    reportId: number;
    fileId: string;
    hash: string;
  };

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
    fileAnnotation?: FileAnnotationsInput;
    additionalInfo?: string;
  };
}
