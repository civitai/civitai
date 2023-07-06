import { unset } from 'lodash-es';
import { z } from 'zod';
import {
  generationParamsSchema,
  generationResourceSchema,
  seedSchema,
} from '~/server/schema/generation.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { findClosest } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';

const GENERATION_FORM_KEY = 'generation-form';

type FormResources = z.infer<typeof resourcesSchema>;
type FormParams = z.infer<typeof paramsSchema>;
type GenerationDataInput = z.input<typeof formatGenerationDataSchema>;

export const generationFormSchema = generationParamsSchema
  .omit({ height: true, width: true, seed: true })
  .extend({
    aspectRatio: z.string(),
    seed: seedSchema.optional(),
  });

const resourcesSchema = generationResourceSchema.array();
const paramsSchema = generationFormSchema.extend({ prompt: z.string().optional() }).partial();

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

const formatGenerationParams = <T extends Partial<Generation.Params>>(
  params: Partial<T>
): FormParams => {
  const { height = 512, width = 512, ...rest } = params;
  const aspectRatios = supportedAspectRatios.map((x) => x.width / x.height);
  const closest = findClosest(aspectRatios, width / height);
  const index = aspectRatios.indexOf(closest);
  const supported = supportedAspectRatios[index] ?? { width: 512, height: 512 };
  const aspectRatio = `${supported.width}x${supported.height}`;

  // remove all all empty props except `seed` so that the input can clear when resetting the generation form
  const formatted = removeEmpty({ ...rest, aspectRatio });
  return { ...formatted, seed: params.seed };
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
