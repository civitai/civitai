export {};

declare global {
  type Prettify<T> = {
    [K in keyof T]: T[K];
  } & NonNullable<unknown>;

  type MakeUndefinedOptional<T> = Prettify<
    {
      [K in keyof T as undefined extends T[K] ? never : K]: T[K];
    } & {
      [K in keyof T as undefined extends T[K] ? K : never]?: T[K];
    }
  >;
}
