import { useEffect, useMemo, useState } from 'react';
import { UNMARKED_SOURCE_IMAGE_HINT } from '~/shared/constants/mature-source.constants';
import { fetchBlobAsFile } from '~/utils/file-utils';
import { ExifParser } from '~/utils/metadata';
import type { ImageStatusAnnotation } from './ImageUploadMultipleInput';

/**
 * Per-image badges for a source-images input: the graph's own `annotations`
 * computed (e.g. upscale) win, and otherwise each image shows whether it
 * carries AI metadata, so users can learn of a PG-13 cap before generating.
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
  const [results, setResults] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!images?.length) return;

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
  }, [images]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    if (!images?.length) return undefined;
    return images.map(({ url }) => {
      if (!(url in results)) return null;
      return results[url]
        ? { label: 'AI Meta', color: 'green', tooltip: 'AI generation metadata detected' }
        : { label: 'No AI Meta', color: 'yellow', tooltip: UNMARKED_SOURCE_IMAGE_HINT };
    });
  }, [images, results]);
}
