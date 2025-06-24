import type { VideoGenInput } from '@civitai/client';
import type { RefinementCtx } from 'zod';
import { z } from 'zod';
import { maxRandomSeed } from '~/server/common/constants';

type VideoGenProcesses = 'txt2vid' | 'img2vid';
export function VideoGenerationConfig2<
  TSchema extends z.AnyZodObject = z.AnyZodObject,
  TOutput extends VideoGenInput = VideoGenInput,
  TDefaults extends z.input<TSchema> = z.input<TSchema>,
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
  superRefine?: (arg: RefinementOutput, ctx: RefinementCtx) => void;
  transformFn: (args: SchemaOutput) => RefinementOutput;
  inputFn: (args: RefinementOutput & { seed: number }) => TOutput;
}) {
  const validationSchema = (
    superRefine ? schema.superRefine(superRefine as any) : schema
  ).superRefine((data, ctx) => {
    if ('prompt' in data && typeof data.prompt === 'string' && data.prompt.length > 1500) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
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
  };
}
