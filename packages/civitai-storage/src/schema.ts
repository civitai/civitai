import * as z from 'zod';

// The storage-service wire contract — the single source of truth the storage app validates POST
// bodies against and that every caller (main app, spokes) types against, so producer and consumer can
// never disagree on the shape. Mirrors the network operations of the monolith's `src/utils/s3-utils.ts`.

// Which credential set / endpoint the service uses for an operation. The service maps each to its own
// env-configured bucket + creds, so callers never hold credentials or pick raw buckets:
//   - default  → S3_UPLOAD_*        (R2 main content bucket)
//   - b2       → S3_UPLOAD_B2_*     (Backblaze model-files bucket)
//   - b2Image  → S3_IMAGE_B2_*      (Backblaze media-uploads / image bucket)
//   - csam     → CSAM_UPLOAD_*      (CSAM evidence bucket)
export const storageBackend = z.enum(['default', 'b2', 'b2Image', 'csam']);
export type StorageBackend = z.infer<typeof storageBackend>;

// `bucket` is an optional override; when omitted the service uses the backend's configured bucket.
const target = z.object({
  backend: storageBackend.default('default'),
  bucket: z.string().optional(),
});

// ---- delete -------------------------------------------------------------------------------------
export const deleteObjectInput = target.extend({ key: z.string() });
export type DeleteObjectInput = z.infer<typeof deleteObjectInput>;

export const deleteManyObjectsInput = target.extend({ keys: z.array(z.string()) });
export type DeleteManyObjectsInput = z.infer<typeof deleteManyObjectsInput>;

// ---- head (exists + metadata) -------------------------------------------------------------------
export const headObjectInput = target.extend({ key: z.string() });
export type HeadObjectInput = z.infer<typeof headObjectInput>;

export const headObjectResult = z.object({
  exists: z.boolean(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  lastModified: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type HeadObjectResult = z.infer<typeof headObjectResult>;

// ---- presign ------------------------------------------------------------------------------------
export const presignPutInput = target.extend({
  key: z.string(),
  expiresIn: z.number().optional(),
});
export type PresignPutInput = z.infer<typeof presignPutInput>;

// Either a `key` (resolved against the backend bucket) or a full `url` (parsed into bucket+key by the
// service). One is required.
export const presignGetInput = target.extend({
  key: z.string().optional(),
  url: z.string().optional(),
  expiresIn: z.number().optional(),
  fileName: z.string().optional(),
});
export type PresignGetInput = z.infer<typeof presignGetInput>;

export const presignResult = z.object({
  url: z.string(),
  bucket: z.string(),
  key: z.string(),
});
export type PresignResult = z.infer<typeof presignResult>;

// ---- multipart ----------------------------------------------------------------------------------
export const presignMultipartInput = target.extend({
  key: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  chunkSize: z.number().optional(),
  expiresIn: z.number().optional(),
});
export type PresignMultipartInput = z.infer<typeof presignMultipartInput>;

export const presignMultipartResult = z.object({
  urls: z.array(z.object({ url: z.string(), partNumber: z.number() })),
  bucket: z.string(),
  key: z.string(),
  uploadId: z.string(),
  // The chunk size the service sized the parts with. Echoed so the uploader slices the file the SAME
  // way (part i = bytes [i-1)*chunkSize, i*chunkSize)); a mismatch corrupts the assembled object.
  chunkSize: z.number(),
});
export type PresignMultipartResult = z.infer<typeof presignMultipartResult>;

export const multipartPart = z.object({ ETag: z.string(), PartNumber: z.number() });
export type MultipartPart = z.infer<typeof multipartPart>;

export const completeMultipartInput = target.extend({
  key: z.string(),
  uploadId: z.string(),
  parts: z.array(multipartPart),
});
export type CompleteMultipartInput = z.infer<typeof completeMultipartInput>;

export const abortMultipartInput = target.extend({
  key: z.string(),
  uploadId: z.string(),
});
export type AbortMultipartInput = z.infer<typeof abortMultipartInput>;

// ---- streaming multipart (unknown/large size) ---------------------------------------------------
// For server-side streaming where the total size isn't known up front: create the upload, then presign
// each part on demand as bytes are read (vs. presignMultipart which presigns all parts at once).
export const createMultipartInput = target.extend({
  key: z.string(),
  mimeType: z.string().optional(),
});
export type CreateMultipartInput = z.infer<typeof createMultipartInput>;

export const createMultipartResult = z.object({
  uploadId: z.string(),
  bucket: z.string(),
  key: z.string(),
});
export type CreateMultipartResult = z.infer<typeof createMultipartResult>;

export const presignPartInput = target.extend({
  key: z.string(),
  uploadId: z.string(),
  partNumber: z.number().int().positive(),
  expiresIn: z.number().optional(),
});
export type PresignPartInput = z.infer<typeof presignPartInput>;

export const presignPartResult = z.object({
  url: z.string(),
  partNumber: z.number(),
});
export type PresignPartResult = z.infer<typeof presignPartResult>;

// ---- multipart error class (over the wire) ------------------------------------------------------
// The service classifies a failed complete/abort and returns the class so the caller can map it to the
// right terminal/retry behavior (instead of a blanket 500 that the client would then retry).
export const multipartErrorClass = z.enum(['not-found', 'invalid-parts', 'transient', 'other']);
export type MultipartErrorClass = z.infer<typeof multipartErrorClass>;
