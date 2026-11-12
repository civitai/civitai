import { createModelDownloadHandler } from '~/pages/api/download/models/[modelVersionId]';
import { hashDownloadRequest } from '~/server/services/download-by-hash.service';

export default createModelDownloadHandler(
  hashDownloadRequest('sha256'),
  '/api/download/sha256/[hash]'
);
