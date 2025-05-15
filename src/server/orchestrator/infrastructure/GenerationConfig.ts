import { VideoGenInput } from '@civitai/client';
import { RefinementCtx, z } from 'zod';
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
  superRefine,
  schema,
  transformFn,
  whatIfFn = (args) => args,
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
  const validationSchema = superRefine ? schema.superRefine(superRefine as any) : schema;
  const _defaultValues = { ...defaultValues, seed: null };

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

  function inputFn(data: SchemaOutput): TOutput {
    const softValidated = schema.parse(data) as SchemaOutput;
    const transformed = transformFn?.(softValidated) ?? softValidated;
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
    getWhatIfValues,
    inputFn,
    transformFn,
  };
}
