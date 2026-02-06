/**
 * Extract Source Metadata
 *
 * Utility for extracting generation metadata (params/resources) from images
 * for use in enhancement workflows.
 */

import type { SourceMetadata } from '~/store/source-metadata.store';
import { ExifParser } from '~/utils/metadata';
import { removeEmpty } from '~/utils/object-helpers';

/**
 * Extracts generation metadata from an image file or URL.
 * Returns params and resources that can be used as sourceMetadata for enhancement workflows.
 *
 * @param source - File object or URL string of the image
 * @returns SourceMetadata with params and resources, or undefined if extraction fails
 */
export async function extractSourceMetadata(
  source: File | string
): Promise<Omit<SourceMetadata, 'extractedAt'> | undefined> {
  try {
    const parser = await ExifParser(source);
    const metadata = await parser.getMetadata();

    // Check if we got valid metadata
    if (!metadata || Object.keys(metadata).length === 0) {
      return undefined;
    }

    // Extract params - all metadata fields except resources and transformations
    const { resources, civitaiResources, additionalResources, transformations, ...params } = metadata as any;

    // Combine all resource arrays
    const allResources = [
      ...(resources ?? []),
      ...(civitaiResources ?? []),
      ...(additionalResources ?? []),
    ];

    // Only return metadata if we have either params or resources
    const hasParams = Object.keys(params).length > 0;
    const hasResources = allResources.length > 0;
    const hasTransformations = Array.isArray(transformations) && transformations.length > 0;

    if (!hasParams && !hasResources && !hasTransformations) {
      return undefined;
    }

    return removeEmpty({
      params: hasParams ? params : undefined,
      resources: hasResources ? allResources : undefined,
      transformations: hasTransformations ? transformations : undefined,
    });
  } catch (error) {
    console.error('Failed to extract source metadata:', error);
    return undefined;
  }
}

/**
 * Fetches an image from a URL and extracts its metadata.
 * Useful for images that are already uploaded/hosted.
 *
 * @param url - URL of the image
 * @returns SourceMetadata with params and resources, or undefined if extraction fails
 */
export async function extractSourceMetadataFromUrl(
  url: string
): Promise<Omit<SourceMetadata, 'extractedAt'> | undefined> {
  try {
    // ExifParser can handle URLs directly
    return await extractSourceMetadata(url);
  } catch (error) {
    console.error('Failed to extract source metadata from URL:', error);
    return undefined;
  }
}
