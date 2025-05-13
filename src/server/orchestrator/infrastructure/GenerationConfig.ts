import { VideoGenInput } from '@civitai/client';
import { RefinementCtx, z } from 'zod';

type VideoGenProcesses = 'txt2vid' | 'img2vid';
type WithSubType = { process: VideoGenProcesses };
export function VideoGenerationConfig2<
  TSchema extends z.AnyZodObject = z.AnyZodObject,
  TOutput extends VideoGenInput = VideoGenInput,
  TDefaults extends z.input<TSchema> = z.input<TSchema>,
  SchemaOutput = z.infer<TSchema>,
  RefinementOutput extends WithSubType = SchemaOutput & TDefaults & WithSubType
>({
  defaultValues,
  superRefine,
  schema,
  transformFn,
  ...args
}: {
  label: string;
  description?: string;
  whatIfProps: string[];
  metadataDisplayProps: string[];
  processes: VideoGenProcesses[];
  schema: TSchema;
  defaultValues?: TDefaults;
  superRefine?: (arg: RefinementOutput, ctx: RefinementCtx) => void;
  transformFn: (args: SchemaOutput) => RefinementOutput;
  inputFn: (args: RefinementOutput) => TOutput;
}) {
  const validationSchema = superRefine ? schema.superRefine(superRefine as any) : schema;

  function validate(data: any) {
    const values = { ...defaultValues, ...data };
    return validationSchema.parse(values);
  }

  function getDefaultValues() {
    return schema.parse({ ...defaultValues });
  }

  function getWhatIfValues(data: any) {
    return schema.parse({ ...defaultValues, ...data });
  }

  function inputFn(data: SchemaOutput): TOutput {
    const softValidated = schema.parse(data) as SchemaOutput;
    const transformed = transformFn?.(softValidated) ?? softValidated;
    return args.inputFn(transformed as any);
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
