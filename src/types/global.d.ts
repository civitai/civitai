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

  type BaseEntity = { id: string } & Record<string, any>;

  enum UploadType {
    Image = 'image',
    TrainingImages = 'training-images',
    Model = 'model',
    Default = 'default',
  }
  type UploadTypeUnion = `${UploadType}`;
}
