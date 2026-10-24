import { extname } from 'node:path';
import { filenamize, generateToken } from '~/utils/string-helpers';

/**
 * The one place an upload key is built. Every uploaded object — browser or server — is
 * `<type>/<userId>/<name>.<token><ext>`, and that shape is load-bearing beyond tidiness:
 * `/api/upload/sign-part` authorises a part by reading the userId out of segment 1, so nothing may be
 * inserted ahead of it.
 *
 * 🔴 Grouping does not belong in a key. A key is immutable once the object exists, so anything encoded
 * in it can never be corrected without copying the bytes. The `HuggingFaceImport` row is what makes an
 * imported object navigable — repo, revision and filename are columns, and columns can be fixed.
 *
 * Lives here rather than in `s3-utils` because that module builds S3 clients at load: a consumer that
 * only needs to name a file should not drag credentials into its module graph, and a test that mocks
 * it should not have to stand up an endpoint config.
 */
export function buildUploadKey(type: string, userId: number, fullFilename: string) {
  const ext = extname(fullFilename);
  const name = filenamize(fullFilename.replace(ext, ''));
  return `${type}/${userId}/${name}.${generateToken(4)}${ext}`;
}
