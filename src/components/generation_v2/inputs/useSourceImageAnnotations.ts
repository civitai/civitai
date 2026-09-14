import { useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { fetchBlobAsFile } from '~/utils/file-utils';
import { ExifParser } from '~/utils/metadata';
import type { ImageStatusAnnotation } from './ImageUploadMultipleInput';

/**
 * Per-image badges for a source-images input: the graph's own `annotations`
 * computed (e.g. upscale) win, and moderators additionally see whether each
 * image carries AI metadata.
 */
export function useSourceImageAnnotations(
  images: { url: string }[] | null | undefined,
  graphAnnotations: (ImageStatusAnnotation | null)[] | undefined
): (ImageStatusAnnotation | null)[] | undefined {
  const aiMeta = useAiMetadataAnnotations(images);
  return useMemo(() => {
    if (!graphAnnotations && !aiMeta) return undefined;
    if (!graphAnnotations) return aiMeta;
    if (!aiMeta) return graphAnnotations;
    const len = Math.max(graphAnnotations.length, aiMeta.length);
    const merged: (ImageStatusAnnotation | null)[] = [];
    for (let i = 0; i < len; i++) {
      merged.push(graphAnnotations[i] ?? aiMeta[i] ?? null);
    }
    return merged;
  }, [graphAnnotations, aiMeta]);
}

function useAiMetadataAnnotations(
  images: { url: string }[] | null | undefined
): (ImageStatusAnnotation | null)[] | undefined {
  const currentUser = useCurrentUser();
  const [results, setResults] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!currentUser?.isModerator || !images?.length) return;

    for (const { url } of images) {
      if (url in results) continue;
      fetchBlobAsFile(url).then(async (file) => {
        if (!file) return;
        const parser = await ExifParser(file);
        const meta = await parser.getMetadata();
        const hasAiMeta = Object.keys(meta).length > 0 || parser.isMadeOnSite();
        setResults((prev) => ({ ...prev, [url]: hasAiMeta }));
      });
    }
  }, [currentUser?.isModerator, images]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    if (!currentUser?.isModerator || !images?.length) return undefined;
    return images.map(({ url }) => {
      if (!(url in results)) return null;
      return results[url]
        ? { label: 'AI Meta', color: 'green', tooltip: 'Valid AI metadata detected' }
        : { label: 'No AI Meta', color: 'yellow', tooltip: 'No AI metadata found in image' };
    });
  }, [currentUser?.isModerator, images, results]);
}
