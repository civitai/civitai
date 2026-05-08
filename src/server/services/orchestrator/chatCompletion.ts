import type { ChatCompletionInput, ChatCompletionStepTemplate } from '@civitai/client';

/**
 * Default vision-capable model. `gpt-4o-mini` accepts text + image inputs
 * and is the cheapest option for prompt-from-image style tasks.
 */
const DEFAULT_CHAT_COMPLETION_MODEL = 'gpt-4o-mini';

/**
 * Input shape for {@link createChatCompletionStep}. Same as the SDK's
 * `ChatCompletionInput` but with `model` optional (defaults to
 * `gpt-4o-mini` when omitted).
 *
 * For image input, include a content part with
 * `imageUrl: { url, detail }` (or snake-case `image_url`) inside a user
 * message — the orchestrator accepts both spellings.
 */
export type ChatCompletionStepInput = Omit<ChatCompletionInput, 'model'> & {
  model?: string;
};

/**
 * Build a `chatCompletion` step suitable for inclusion in a workflow.
 * Use this in any handler that wants to chain a chat completion before a
 * generation step — the step's `output.choices[0].message.content` can
 * then be referenced by the downstream step via
 * `{ $ref: '$N', path: 'output.choices[0].message.content' }` (or use
 * {@link createChainedChatCompletionStep} which builds the ref for you).
 *
 * Pass `suppressOutput: true` to keep the chat output off user-visible
 * results (typical when the chat output feeds another step).
 */
export function createChatCompletionStep(
  input: ChatCompletionStepInput,
  options?: { name?: string; suppressOutput?: boolean }
): ChatCompletionStepTemplate {
  return {
    $type: 'chatCompletion',
    name: options?.name,
    input: {
      ...input,
      model: input.model ?? DEFAULT_CHAT_COMPLETION_MODEL,
    },
    metadata: options?.suppressOutput ? { suppressOutput: true } : undefined,
  };
}

/**
 * Like {@link createChatCompletionStep}, but also returns a ready-to-wire
 * `$ref` for the assistant message content. Use this when chaining a chat
 * completion before another step so the downstream step can read the
 * generated text without the caller having to compute the `$N` index or
 * cast the ref to `string`.
 *
 * @example
 * const { step, content: contentRef } = createChainedChatCompletionStep(
 *   { messages: [...] },
 *   { stepIndex: steps.length, suppressOutput: true }
 * );
 * steps.push(step);
 * // pass contentRef into a downstream step's input field that accepts string
 */
export function createChainedChatCompletionStep(
  input: ChatCompletionStepInput,
  options: { stepIndex: number; name?: string; suppressOutput?: boolean }
): {
  step: ChatCompletionStepTemplate;
  /** $ref to `output.choices[0].message.content`, typed as string for direct use in step inputs. */
  content: string;
} {
  const step = createChatCompletionStep(input, {
    name: options.name,
    suppressOutput: options.suppressOutput,
  });
  const ref = `$${options.stepIndex}`;
  return {
    step,
    content: {
      $ref: ref,
      path: 'output.choices[0].message.content',
    } as unknown as string,
  };
}
