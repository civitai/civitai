import { WorkflowConfigInputProps } from './input.types';

import { ComfyInput, KlingVideoGenInput, TextToImageInput } from '@civitai/client';
import { z } from 'zod';
import {
  GenerationType,
  OrchestratorEngine,
} from '~/server/orchestrator/infrastructure/base.enums';

interface IVideoGenerationConfig<TSchema extends z.AnyZodObject> {
  subType: GenerationType;
  schema: TSchema;
  inputs: (keyof z.TypeOf<TSchema>)[];
  engine: OrchestratorEngine;
  metadataDisplayProps: Array<keyof z.output<TSchema>>;
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
    this.inputs = args.inputs;
  }

  type = 'video';
  subType: GenerationType;
  engine: OrchestratorEngine;
  metadataDisplayProps: Array<keyof z.output<TSchema>>;
  schema: TSchema;
  key: string;
  inputs: (keyof z.TypeOf<TSchema>)[];
}

// type ConfigurationOptions<TSchema extends z.AnyZodObject = z.AnyZodObject> = {
//   subType: GenerationType;
//   schema: TSchema;
//   key: string;
//   fields: (keyof z.TypeOf<TSchema>)[];
// };

// interface IGenerationConfig {
//   engine: OrchestratorEngine;
//   label: string;
//   description?: string;
//   inputs: Record<string, WorkflowConfigInputProps>;
// }

// export class GenerationConfig implements IGenerationConfig {
//   constructor(args: IGenerationConfig) {
//     this.engine = args.engine;
//     this.label = args.label;
//     this.description = args.description;
//     this.inputs = args.inputs;
//   }

//   engine: OrchestratorEngine;
//   label: string;
//   description?: string;
//   inputs: Record<string, WorkflowConfigInputProps>;

//   toClientConfig = <TSchema extends z.AnyZodObject, SubType extends GenerationType>(
//     config: ClientGenerationConfigOptions<TSchema, SubType>
//   ) => {
//     return new ClientGenerationConfig({ ...this, ...config });
//   };
// }

// type ClientGenerationConfigOptions<
//   TSchema extends z.AnyZodObject,
//   SubType extends GenerationType
// > = {
//   subType: SubType;
//   schema: TSchema;
//   fields: (keyof z.TypeOf<TSchema>)[];
// };

// class ClientGenerationConfig<
//   TSchema extends z.AnyZodObject = z.AnyZodObject,
//   SubType extends GenerationType = GenerationType
// > extends GenerationConfig {
//   constructor(args: ClientGenerationConfigOptions<TSchema, SubType> & IGenerationConfig) {
//     super(args);
//     this.subType = args.subType;
//     this.schema = args.schema;
//     this.fields = args.fields;
//     this.key = `${args.engine}-${args.subType}`;
//   }

//   subType: SubType;
//   schema: TSchema;
//   fields: (keyof z.TypeOf<TSchema>)[];
//   key: string;
// }

// export function generationConfig<TSchema extends z.AnyZodObject>(args: {
//   engine: OrchestratorEngine;
//   label: string;
//   description?: string;
//   inputs: Record<string, WorkflowConfigInputProps>;
//   configurations?: ConfigurationOptions<TSchema>[];
// }) {
//   return {
//     ...args,
//     with: <TConfigSchema extends z.AnyZodObject>(
//       config: Omit<ConfigurationOptions<TConfigSchema>, 'key'>
//     ) => ({
//       ...generationConfig(args),
//       configurations: [
//         ...(args.configurations ?? []),
//         { ...config, key: `${args.engine}-${config.subType}` },
//       ],
//     }),
//   };
// }

function generationConfig({}: {
  engine: ''; // todo - rename to something else
  label: string;
  description?: string;
  inputs: Record<string, WorkflowConfigInputProps>;
});
