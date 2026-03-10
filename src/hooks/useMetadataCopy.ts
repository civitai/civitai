import { useCallback, useState } from 'react';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { copyMetadataToClipboard } from '~/utils/metadata';

export function useMetadataCopy(meta: ImageMetaProps | undefined, timeout = 2000) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    if (!meta) return;
    const success = await copyMetadataToClipboard(meta);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), timeout);
    }
  }, [meta, timeout]);
  return { copy, copied };
}
