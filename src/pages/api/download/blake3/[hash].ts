import { createModelDownloadHandler } from '~/pages/api/download/models/[modelVersionId]';
import { hashDownloadRequest } from '~/server/services/download-by-hash.service';

export default createModelDownloadHandler(
  hashDownloadRequest('blake3'),
  '/api/download/blake3/[hash]'
);
