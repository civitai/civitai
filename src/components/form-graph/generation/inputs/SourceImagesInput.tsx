import { useField } from 'form-graph/react';

import type { ImageMetadataApply } from '~/components/Generation/Input/ImageMetadataModal';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import {
  ImageUploadMultipleInput,
  type ImageStatusAnnotation,
  type ImageValue,
} from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { useSourceImageAnnotations } from '~/components/generation_v2/inputs/useSourceImageAnnotations';
import type { ImagesMeta } from '~/shared/form-graph/generation/defs';
import type { GenerationResource } from '~/shared/types/generation.types';

import type { GenerationStore } from '../store';

/** The generation_v2 `ImagesInput`, reading the same fields off the form-graph store. */
export function SourceImagesInput({
  store,
  value,
  onChange,
  meta,
  error,
}: {
  store: GenerationStore;
  value: ImageValue[] | undefined;
  onChange: (value: ImageValue[]) => void;
  meta: ImagesMeta | undefined;
  error: string | undefined;
}) {
  const workflow = useField<string>(store, 'workflow')?.value;
  const annotationsField = useField<(ImageStatusAnnotation | null)[]>(store, 'annotations');
  const annotations = useSourceImageAnnotations(value, annotationsField?.value);
  const resourcesField = useField<
    GenerationResource[],
    { options?: ResourceSelectOptions; limit?: number }
  >(store, 'resources');

  const metadataApply: ImageMetadataApply = {
    canApply: (key) => store.getField(key) != null,
    onApply: (values) => store.set(values),
    resourceOptions: resourcesField?.meta?.options,
    onAddResource: resourcesField
      ? (resource) => {
          const state = store.getSnapshot().state as { resources?: GenerationResource[] };
          const current = state.resources ?? [];
          const limit = resourcesField.meta?.limit;
          if (current.some((r) => r.id === resource.id)) return;
          if (limit != null && current.length >= limit) return;
          store.set({ resources: [...current, resource] });
        }
      : undefined,
  };

  return (
    <ImageUploadMultipleInput
      label="Source images"
      value={value}
      onChange={onChange}
      aspect="square"
      max={meta?.max}
      slots={meta?.slots}
      error={error}
      enableDrawing={workflow === 'img2img:edit'}
      warnOnMissingAiMetadata={meta?.warnOnMissingAiMetadata}
      aspectRatios={meta?.aspectRatios as `${number}:${number}`[] | undefined}
      imageAnnotations={annotations}
      imageLayout="wrap"
      enableMetadataExtraction
      metadataApply={metadataApply}
    />
  );
}
