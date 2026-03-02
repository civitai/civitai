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

import type { GenerationHandlerCtx } from '.';

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
 *
 * @example
 * ```typescript
 * export const createViduInput = defineHandler<ViduCtx, ViduVideoGenInput>(
 *   (data, ctx) => {
 *     return removeEmpty({
 *       engine: 'vidu',
 *       prompt: data.prompt,
 *       // ...
 *     });
 *   }
 * );
 * ```
 */
export function defineHandler<TData, TOutput>(
  fn: HandlerFn<TData, TOutput>
): HandlerFn<TData, TOutput> {
  return fn;
}
