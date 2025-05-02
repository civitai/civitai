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
  SchemaOutput = z.infer<TSchema>,
  SchemaInput = z.input<TSchema>,
  RefinedOutput extends SchemaOutput = SchemaOutput
>({
  defaultValues,
  superRefine,
  ...args
}: {
  label: string;
  description?: string;
  whatIfProps: string[];
  metadataDisplayProps: string[];
  schema: TSchema;
  inputFn: (args: SchemaOutput) => TOutput;
  defaultValues?: SchemaInput;
  superRefine?: (arg: SchemaOutput, ctx: RefinementCtx) => void;
}) {
  function validate(data: any) {
    const values = { ...defaultValues, ...data };
    return superRefine
      ? args.schema.superRefine(superRefine as any).parse(values)
      : args.schema.parse(values);
  }

  function getDefaultValues() {
    return args.schema.parse(defaultValues);
  }

  function getWhatIfValues(data: any) {
    return args.schema.parse({ ...defaultValues, ...data });
  }

  return { ...args, getDefaultValues, validate, getWhatIfValues };
}
