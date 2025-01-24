/* eslint-disable @typescript-eslint/no-explicit-any */

import { FileWithPath } from '@mantine/dropzone';
import { ImageAnalysisInput } from '~/server/schema/image.schema';
import { TrainingResults } from '~/server/schema/model-file.schema';
import { LabelTypes } from '~/store/training.store';

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

  type DeepNonNullable<T> = { [P in keyof T]-?: NonNullable<T[P]> } & NonNullable<T>;

  type Nullable<T> = { [K in keyof T]: T[K] | null };

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

  type UploadResult = { url: string; id: string };

  type ImageUploadResponse = { id: string; uploadURL: string } | { error: string };

  type ElementDataAttributes = {
    [key: `data-${string}`]: string;
  };

  interface Window {
    logSignal: (target: string, selector?: (args: unknown) => unknown) => void;
    ping: () => void;
    Twitch: any;
    isAuthed?: boolean;
    authChecked?: boolean;
  }
}
