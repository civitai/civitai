import { OpenRouter } from '@openrouter/sdk';
import type { Message, SystemMessage, UserMessage } from '@openrouter/sdk/models';
import { isProd } from '~/env/other';
import { env } from '~/env/server';

// Model aliases for easier usage
export const AI_MODELS = {
  // Primary models for complex tasks
  GPT_4O: 'openai/gpt-4o',
  GPT_4O_MINI: 'openai/gpt-4o-mini',
  CLAUDE_SONNET: 'anthropic/claude-sonnet-4',
  CLAUDE_HAIKU: 'anthropic/claude-3-5-haiku',

  KIMI: 'moonshotai/kimi-k2.5',
  GROK: 'x-ai/grok-4.1-fast',
  GPT_5_NANO: 'openai/gpt-5-nano',

  // Fallback chains
  VISION_PRIMARY: 'openai/gpt-4o',
  VISION_FALLBACK: 'anthropic/claude-sonnet-4',
} as const;

export type AIModel = (typeof AI_MODELS)[keyof typeof AI_MODELS] | string;

// Simple message types that get converted to SDK format
type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image_url'; image_url: { url: string } };
type ContentItem = TextContent | ImageContent;

export type SimpleMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentItem[];
};

type GetJsonCompletionInput = {
  model?: AIModel;
  messages: SimpleMessage[];
  temperature?: number;
  maxTokens?: number;
  retries?: number;
};

// Convert our simple message format to SDK format
function toSDKMessage(msg: SimpleMessage): Message {
  if (msg.role === 'system') {
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((c) => {
            if (c.type === 'text') return { type: 'text' as const, text: c.text };
            throw new Error('System messages cannot contain images');
          });
    return { role: 'system', content } as SystemMessage;
  }

  if (msg.role === 'user') {
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((c) => {
            if (c.type === 'text') return { type: 'text' as const, text: c.text };
            if (c.type === 'image_url')
              return { type: 'image_url' as const, imageUrl: { url: c.image_url.url } };
            throw new Error('Unknown content type');
          });
    return { role: 'user', content } as UserMessage;
  }

  // Assistant messages
  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content : '',
  };
}

type CustomOpenRouter = OpenRouter & {
  getJsonCompletion: <T>(params: GetJsonCompletionInput) => Promise<T>;
};

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalOpenRouter: CustomOpenRouter | undefined;
}

function createOpenRouterClient() {
  const client = new OpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
  });

  const customClient = client as CustomOpenRouter;

  customClient.getJsonCompletion = async <T>({
    model = AI_MODELS.GPT_5_NANO,
    messages,
    temperature = 1,
    maxTokens = 2048,
    retries = 0,
  }: GetJsonCompletionInput): Promise<T> => {
    const sdkMessages = messages.map(toSDKMessage);

    const response = await client.chat.send({
      model,
      messages: sdkMessages,
      temperature,
      maxTokens,
      responseFormat: { type: 'json_object' },
      provider: {
        allowFallbacks: true,
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      if (retries > 0) {
        return customClient.getJsonCompletion<T>({
          model,
          messages,
          temperature,
          maxTokens,
          retries: retries - 1,
        });
      }
      throw new Error('No content in response');
    }

    try {
      // Try to parse as JSON directly
      return JSON.parse(content) as T;
    } catch {
      // Try to extract JSON from markdown code block
      const jsonBlockMatch = content.match(/```json\n(.*?)\n```/s)?.[1];
      if (jsonBlockMatch) {
        try {
          return JSON.parse(jsonBlockMatch) as T;
        } catch {
          // Fall through to retry/error
        }
      }

      if (retries > 0) {
        return customClient.getJsonCompletion<T>({
          model,
          messages,
          temperature,
          maxTokens,
          retries: retries - 1,
        });
      }
      console.error('Failed to parse JSON from content:', content);
      throw new Error('Failed to parse JSON from completion');
    }
  };

  return customClient;
}

export let openrouter: CustomOpenRouter | undefined;
const shouldConnect = env.OPENROUTER_API_KEY;
if (shouldConnect) {
  if (isProd) {
    openrouter = createOpenRouterClient();
  } else {
    if (!global.globalOpenRouter) global.globalOpenRouter = createOpenRouterClient();
    openrouter = global.globalOpenRouter;
  }
}
