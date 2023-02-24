/* eslint-disable @typescript-eslint/no-explicit-any */
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
    nsfw?: boolean;
    tags?: Array<{ id: number; name: string; isCategory: boolean }>;
    // navigation properties
    uuid?: string;
    analysis?: ImageAnalysisInput;
    status?: 'processing' | 'uploading' | 'complete' | 'blocked' | 'error';
    blockedFor?: string[];
    message?: string;
  };

  type DeepNonNullable<T> = { [P in keyof T]-?: NonNullable<T[P]> } & NonNullable<T>;

  // eslint-disable-next-line no-var, vars-on-top
  var navigation: { currentEntry: { index: number } };
}
