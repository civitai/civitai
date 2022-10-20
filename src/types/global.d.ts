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
  type BaseEntity = { id: string } & MixedObject;

  type CustomFile = {
    id: string;
    url: string;
    name: string;
    file: FileWithPath;
  };
}
