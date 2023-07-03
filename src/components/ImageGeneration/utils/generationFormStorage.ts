import { unset } from 'lodash-es';
import { z } from 'zod';
import {
  generationParamsSchema,
  generationResourceSchema,
} from '~/server/schema/generation.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { removeEmpty } from '~/utils/object-helpers';

const GENERATION_FORM_KEY = 'generation-form';

type FormResources = z.infer<typeof resourcesSchema>;
type FormParams = z.infer<typeof paramsSchema>;
type GenerationDataInput = z.input<typeof formatGenerationDataSchema>;

export const generationFormSchema = generationParamsSchema
  .omit({ height: true, width: true, seed: true })
  .extend({
    aspectRatio: z.string(),
    seed: z.number().nullish(),
  });

const resourcesSchema = generationResourceSchema.array();
const paramsSchema = generationFormSchema
  .extend({ prompt: z.string().max(1000).optional() })
  .partial();

const formatGenerationDataSchema = z.object({
  resources: resourcesSchema.default([]),
  params: paramsSchema.optional(),
});

const parseGenerationData = (data: GenerationDataInput) => {
  try {
    const results = formatGenerationDataSchema.safeParse(data);
    if (results.success) return results.data;
    // remove bad `param` props and and parse again
    for (const error of results.error.errors) {
      if (error.path[0] === 'params') {
        unset(data, error.path);
      }
    }
    return formatGenerationDataSchema.parse(data);
  } catch (error: any) {
    console.warn('invalid generation data format');
    console.warn({ error });
  }
};

// TODO.generation - grab the closest image dimensions based on aspect ratio
const formatGenerationParams = <T extends Generation.DataParams>(
  params: Partial<T>
): FormParams => {
  const { height = 0, width = 0, ...rest } = params;
  const seed = params.seed ?? -1;
  const aspectRatio = supportedAspectRatios.some((x) => x.width === width && x.height === height)
    ? `${width}x${height}`
    : '512x512';

  // remove all all empty props except `seed` so that the input can clear when resetting the generation form
  const formatted = removeEmpty({ ...rest, aspectRatio });
  return { ...formatted, seed: seed > -1 ? seed : null };
};

export const supportedAspectRatios = [
  { label: 'Square', width: 512, height: 512 },
  { label: 'Landscape', width: 768, height: 512 },
  { label: 'Portrait', width: 512, height: 768 },
];

class GenerationForm {
  private _data?: z.infer<typeof formatGenerationDataSchema>;

  private _getStorage = () => {
    const value = localStorage.getItem(GENERATION_FORM_KEY);
    return value ? parseGenerationData(JSON.parse(value)) : undefined;
  };

  setData = (data: Partial<Generation.Data>) => {
    const nsfw = this._data?.params?.nsfw;
    const params = data.params ? formatGenerationParams(data.params) : this._data?.params;
    const parsed = parseGenerationData({
      resources: data.resources ?? this._data?.resources,
      params: { nsfw, ...params },
    });
    if (parsed) {
      this._data = parsed;
      localStorage.setItem(GENERATION_FORM_KEY, JSON.stringify(parsed));
    }
    return this.data;
  };

  get data() {
    if (!this._data) this._data = this._getStorage();
    return this._data ?? { resources: [] };
  }

  setParam = <K extends keyof FormParams>(key: K, value: FormParams[K]) => {
    this.setData({ params: { ...this._data?.params, [key]: value } });
  };
}

const generationForm = new GenerationForm();

export default generationForm;
