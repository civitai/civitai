import pLimit from 'p-limit';
import { fetchBlob } from '~/utils/file-utils';
import { isDefined } from '~/utils/type-guards';

export async function getOrchestratorMediaFilesFromUrls(
  urls: string[],
  concurrencyLimit = Infinity
) {
  const limit = pLimit(concurrencyLimit);
  const files = await Promise.all(
    urls.map((url) =>
      limit(async () => {
        const blob = await fetchBlob(url);
        if (!blob) return;
        const lastIndex = url.lastIndexOf('/');
        const name = url.substring(lastIndex + 1);
        return new File([blob], name, { type: blob.type });
      })
    )
  );
  return files.filter(isDefined);
}
