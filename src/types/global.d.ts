/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MantineSize } from '@mantine/core';
import type { FileWithPath } from '@mantine/dropzone';
import type { ImageAnalysisInput } from '~/server/schema/image.schema';
import type { TrainingResults } from '~/server/schema/model-file.schema';
import type { MediaType } from '~/shared/utils/prisma/enums';
import type { LabelTypes } from '~/store/training.store';

export {};

declare global {
  /**
   * @see https://stackoverflow.com/a/59774743
   */
  type AsyncReturnType<T extends (...args: any) => Promise<any>> = T extends (
    ...args: any
  ) => Promise<infer R>
    ? R
    : any;

  type BrowserNativeObject = Date | FileList | File;
  type DeepPartial<T> = T extends BrowserNativeObject
    ? T
    : T extends object
    ? {
        [K in keyof T]?: DeepPartial<T[K]>;
      }
    : T;

  type Prettify<T> = {
    [K in keyof T]: T[K];
  } & NonNullable<unknown>;

  type StringLiteral<T> = T extends string ? (string extends T ? never : T) : never;

  // Utility type to extract string values recursively
  type Values<T> = T extends object
    ? Values<T[keyof T]> // Recurse into nested objects
    : T;

  type MixedObject = Record<string, any>;
  type BaseEntity = { id: number | string } & MixedObject;

  type Entries<T> = {
    [K in keyof T]: [K, T[K]];
  }[keyof T][];

  type CustomFile = {
    id?: number;
    url: string;
    previewUrl?: string;
    onLoad?: () => void;
    name?: string;
    meta?: Record<string, unknown> | null;
    file?: FileWithPath;
    height?: number | null;
    width?: number | null;
    hash?: string;
    tags?: Array<{ id: number; name: string; isCategory: boolean }>;
    // navigation properties
    uuid?: string;
    analysis?: ImageAnalysisInput;
    status?: 'processing' | 'uploading' | 'complete' | 'blocked' | 'error';
    blockedFor?: string[];
    message?: string;
  };

  type DeepRequired<T> = T extends BrowserNativeObject | Blob
    ? T
    : {
        [K in keyof T]-?: NonNullable<DeepRequired<T[K]>>;
      };

  type DeepNonNullable<T> = { [P in keyof T]-?: NonNullable<T[P]> } & NonNullable<T>;

  type Nullable<T> = { [K in keyof T]: T[K] | null };
  type Primitive = string | number | boolean | bigint | symbol | undefined | null;
  type Builtin = Primitive | Date | Error | RegExp;
  type IsUnknown<Type> = IsAny<Type> extends true ? false : unknown extends Type ? true : false;

  // eslint-disable-next-line no-var, vars-on-top
  var navigation: { currentEntry: { index: number } };

  type TrackedFile = {
    file: File;
    progress: number;
    uploaded: number;
    size: number;
    speed: number;
    timeRemaining: number;
    name: string;
    status: 'pending' | 'error' | 'success' | 'uploading' | 'aborted' | 'blocked';
    abort: () => void;
    uuid: string;
    meta?: Record<string, unknown>;
    id?: number;
  };

  type ModelFileFormat =
    | 'SafeTensor'
    | 'PickleTensor'
    | 'GGUF'
    | 'Diffusers'
    | 'Core ML'
    | 'ONNX'
    | 'Other';
  type ModelFileSize = 'full' | 'pruned';
  type ModelFileFp = 'fp32' | 'fp16' | 'bf16' | 'fp8' | 'nf4';
  type ImageFormat = 'optimized' | 'metadata';

  type UserFilePreferences = {
    format: ModelFileFormat;
    size: ModelFileSize;
    fp: ModelFileFp;
    imageFormat: ImageFormat;
  };

  type BasicFileMetadata = {
    format?: ModelFileFormat;
    size?: ModelFileSize;
    fp?: ModelFileFp;
  };

  // TODO should find a way to merge this with ModelFileMetadata
  type FileMetadata = BasicFileMetadata & {
    labelType?: LabelTypes;
    ownRights?: boolean;
    shareDataset?: boolean;
    numImages?: number;
    numCaptions?: number;
    selectedEpochUrl?: string;
    trainingResults?: TrainingResults;
  };

  type TypeCategory = { id: number; name: string; priority: number; adminOnly: boolean };

  type UploadResult = { url: string; id: string; type: MediaType };

  type ImageUploadResponse = { id: string; uploadURL: string } | { error: string };

  type ElementDataAttributes = {
    [key: `data-${string}`]: string;
  };

  interface Window {
    logSignal: (target: string, selector?: (args: unknown) => unknown) => void;
    ping: () => void;
    signalsDump: () => void;
    signalsStatus: () => void;
    signalsVerbose: () => void;
    Twitch: any;
    isAuthed?: boolean;
    authChecked?: boolean;
  }

  type MantineSpacing = MantineSize | number;
}
