import { VideoGenInput } from '@civitai/client';
import { RefinementCtx, ZodEffects, z } from 'zod';
import {
  GenerationType,
  OrchestratorEngine,
} from '~/server/orchestrator/infrastructure/base.enums';

interface IVideoGenerationConfig<TSchema extends z.AnyZodObject> {
  subType: GenerationType;
  engine: OrchestratorEngine;
  metadataDisplayProps: Array<keyof z.output<TSchema>>;
  schema: TSchema;
}

export class VideoGenerationConfig<TSchema extends z.AnyZodObject = z.AnyZodObject>
  implements IVideoGenerationConfig<TSchema>
{
  constructor(args: IVideoGenerationConfig<TSchema>) {
    this.subType = args.subType;
    this.engine = args.engine;
    this.metadataDisplayProps = args.metadataDisplayProps;
    this.schema = args.schema;
    this.key = `${args.engine}-${args.subType}`;
  }

  type = 'video';
  subType: GenerationType;
  engine: OrchestratorEngine;
  metadataDisplayProps: Array<keyof z.output<TSchema>>;
  schema: TSchema;
  key: string;
}

// export class ImageGenerationConfig<TSchema extends z.AnyZodObject = z.AnyZodObject> {
//   constructor() {}
//   type = 'image';
//   subType: GenerationType;
//   schema: TSchema;
//   key: string;
// }

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
  ...args
}: {
  label: string;
  description?: string;
  whatIfProps: string[];
  metadataDisplayProps: string[];
  schema: TSchema;
  defaultValues?: TDefaults;
  superRefine?: (arg: RefinementOutput, ctx: RefinementCtx) => void;
  transformFn?: (args: SchemaOutput) => RefinementOutput;
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
    const transformed = transformFn?.(data) ?? data;
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
  };
}
