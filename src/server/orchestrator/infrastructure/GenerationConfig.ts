import type { VideoGenInput } from '@civitai/client';
import * as z from 'zod';
import { maxRandomSeed } from '~/server/common/constants';

type VideoGenProcesses = 'txt2vid' | 'img2vid' | 'ref2vid';
export function VideoGenerationConfig2<
  TSchema extends z.ZodType<Record<string, unknown>, Record<string, unknown>>,
  TDefaults extends z.input<TSchema> = z.input<TSchema>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
  SchemaOutput = z.infer<TSchema>,
  RefinementOutput = SchemaOutput & TDefaults
>({
  defaultValues,
  schema,
  transformFn,
  whatIfFn = (args) => args,
  superRefine,
  ...args
}: {
  label: string;
  description?: string;
  whatIfProps: string[];
  metadataDisplayProps: string[];
  processes: VideoGenProcesses[];
  schema: TSchema;
  defaultValues?: TDefaults;
  whatIfFn?: (arg: SchemaOutput) => SchemaOutput;
  superRefine?: (arg: RefinementOutput, ctx: z.RefinementCtx) => void;
  transformFn: (args: SchemaOutput) => RefinementOutput;
  inputFn: (args: RefinementOutput & { seed: number }) => TOutput;
  /** map from transformed data back to the input schema */
  legacyMapFn?: (args: Record<string, any>) => z.input<TSchema>;
}) {
  const validationSchema = (
    superRefine ? schema.superRefine(superRefine as any) : schema
  ).superRefine((data, ctx) => {
    if ('prompt' in data && typeof data.prompt === 'string' && data.prompt.length > 1500) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt cannot be longer than 1500 characters',
        path: ['prompt'],
      });
    }

    if (
      'negativePrompt' in data &&
      typeof data.negativePrompt === 'string' &&
      data.negativePrompt.length > 1500
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Negative prompt cannot be longer than 1000 characters',
        path: ['negativePrompt'],
      });
    }
  });
  const _defaultValues = { ...defaultValues, seed: null };

  function softValidate(data: any) {
    const values = { ..._defaultValues, ...data };
    return schema.parse(values);
  }

  function validate(data: any) {
    const values = { ..._defaultValues, ...data };
    return validationSchema.parse(values);
  }

  function getDefaultValues() {
    return schema.parse({ ..._defaultValues });
  }

  function getWhatIfValues(data: any) {
    const whatIfDefaults = { ..._defaultValues, ...data };
    const parsed = schema.parse(whatIfDefaults) as SchemaOutput;
    return whatIfFn(parsed);
  }

  function metadataFn(data: SchemaOutput) {
    const softValidated = schema.parse({ ...defaultValues, ...data }) as SchemaOutput;
    return transformFn?.(softValidated) ?? softValidated;
  }

  function inputFn(data: SchemaOutput): TOutput {
    const transformed = metadataFn(data);
    const result = args.inputFn(transformed as any);
    const seed =
      !('seed' in result) || !result.seed ? Math.floor(Math.random() * maxRandomSeed) : result.seed;
    return { ...result, seed };
  }

  function legacyMapFn(data: Record<string, any>) {
    if (data.type === 'txt2vid' || data.type === 'img2vid') data.process = data.type;
    const mapped = args.legacyMapFn?.(data) ?? data;
    return mapped as z.input<TSchema>;
  }

  return {
    ...args,
    schema,
    validationSchema,
    getDefaultValues,
    validate,
    softValidate,
    getWhatIfValues,
    metadataFn,
    inputFn,
    transformFn,
    legacyMapFn,
  };
}
