/**
 * Ecosystem Handler Factory
 *
 * Provides a typed factory function for creating ecosystem handlers
 * with a consistent signature: (data, ctx) => Promise<Output>
 *
 * Benefits:
 * - Enforces consistent handler signatures at the type level
 * - No need for _unused parameter prefixes (arrow fn params aren't flagged)
 * - Single place to add middleware (logging, error handling, timing) in the future
 */

import type { GenerationHandlerCtx, StepInput } from '.';

/**
 * Handler function signature.
 * All ecosystem handlers follow this pattern.
 */
export type HandlerFn<TData, TOutput> = (
  data: TData,
  ctx: GenerationHandlerCtx
) => TOutput | Promise<TOutput>;

/**
 * Creates a typed ecosystem handler.
 * TOutput must be a tuple/array of StepInput — handlers always return an array of steps,
 * even when producing a single step (return [step]).
 *
 * @example
 * ```typescript
 * export const createViduInput = defineHandler<ViduCtx, [VideoGenStepTemplate]>(
 *   (data, ctx) => {
 *     return [{ $type: 'videoGen', input: removeEmpty({ engine: 'vidu', ... }) }];
 *   }
 * );
 * ```
 */
export function defineHandler<TData, TOutput extends StepInput[]>(
  fn: HandlerFn<TData, TOutput>
): HandlerFn<TData, TOutput> {
  return fn;
}
