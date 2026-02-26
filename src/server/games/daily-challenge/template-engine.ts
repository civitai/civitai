import * as z from 'zod';
import type { SimpleMessage } from '~/server/services/ai/openrouter';

// Zod schema for validating review template JSON
const contentItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string() }),
  }),
]);

export const reviewTemplateSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.union([z.string(), z.array(contentItemSchema)]),
      })
    )
    .min(1),
});

export type ReviewTemplate = z.infer<typeof reviewTemplateSchema>;

export type ReviewTemplateVariables = {
  systemPrompt: string;
  reviewPrompt: string;
  theme: string;
  themeElements: string;
};

/**
 * Parse and validate a JSON review template string.
 * Throws on invalid JSON or schema mismatch.
 */
export function parseReviewTemplate(json: string): ReviewTemplate {
  const parsed = JSON.parse(json);
  return reviewTemplateSchema.parse(parsed);
}

/**
 * Deep-walk a template's message tree, replacing {{var}} placeholders
 * with values from the variables map. Returns resolved SimpleMessage[].
 */
export function resolveTemplate(
  template: ReviewTemplate,
  variables: ReviewTemplateVariables
): SimpleMessage[] {
  const vars = variables as Record<string, string>;

  function replaceVars(text: string): string {
    return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      if (key in vars) return vars[key];
      console.warn(`[template-engine] Unrecognized template variable: ${match}`);
      return match;
    });
  }

  return template.messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: replaceVars(msg.content) };
    }

    return {
      role: msg.role,
      content: msg.content.map((item) => {
        if (item.type === 'text') {
          return { type: 'text' as const, text: replaceVars(item.text) };
        }
        return {
          type: 'image_url' as const,
          image_url: { url: replaceVars(item.image_url.url) },
        };
      }),
    };
  });
}
