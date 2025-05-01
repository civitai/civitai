import { VideoGenInput } from '@civitai/client';
import { z } from 'zod';
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
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends VideoGenInput = VideoGenInput
>({
  defaultValues,
  ...args
}: {
  label: string;
  description?: string;
  whatIfProps: string[];
  metadataDisplayProps: string[];
  schema: TSchema;
  inputFn: (args: z.infer<TSchema>) => TOutput;
  defaultValues?: z.input<TSchema>;
}) {
  function validate(data: any) {
    return args.schema.parse(data);
  }

  function getDefaultValues() {
    return validate(defaultValues);
  }

  return { ...args, getDefaultValues, validate };
}
