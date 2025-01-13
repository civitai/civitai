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
