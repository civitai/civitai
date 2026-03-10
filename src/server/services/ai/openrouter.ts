import { OpenRouter } from '@openrouter/sdk';
import type {
  ChatMessageToolCall,
  Message,
  SystemMessage,
  ToolDefinitionJson,
  ToolResponseMessage,
  UserMessage,
} from '@openrouter/sdk/models';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { agentLog } from '~/server/freshdesk-agent/freshdesk-debug';

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
  STEP_FUN: 'stepfun/step-3.5-flash:free',

  // Fallback chains
  VISION_PRIMARY: 'openai/gpt-4o',
  VISION_FALLBACK: 'anthropic/claude-sonnet-4',
} as const;

// eslint-disable-next-line @typescript-eslint/ban-types
export type AIModel = (typeof AI_MODELS)[keyof typeof AI_MODELS] | (string & {});

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

export type RunAgentLoopInput = {
  model?: AIModel;
  system: string;
  userMessage: string;
  tools: ToolDefinitionJson[];
  executeToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
};

export type AgentLoopResult = {
  response: string;
  turnsUsed: number;
  toolCallsExecuted: number;
  exhausted: boolean;
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
  runAgentLoop: (params: RunAgentLoopInput) => Promise<AgentLoopResult>;
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

  customClient.runAgentLoop = async ({
    model = AI_MODELS.CLAUDE_SONNET,
    system,
    userMessage,
    tools,
    executeToolCall,
    maxTurns = 15,
    maxTokens = 4096,
    temperature = 0,
  }: RunAgentLoopInput): Promise<AgentLoopResult> => {
    const messages: Message[] = [
      { role: 'system', content: system } as SystemMessage,
      { role: 'user', content: userMessage } as UserMessage,
    ];

    let turnsUsed = 0;
    let toolCallsExecuted = 0;

    while (turnsUsed < maxTurns) {
      turnsUsed++;
      agentLog(`--- TURN ${turnsUsed}/${maxTurns} ---`);

      const response = await client.chat.send({
        model,
        messages,
        tools,
        maxTokens,
        temperature,
        provider: { allowFallbacks: true },
      });

      const choice = response.choices?.[0];
      if (!choice) throw new Error('No choice in agent loop response');

      const assistantMessage = choice.message;
      // Push the assistant message to conversation history
      messages.push(assistantMessage as unknown as Message);

      const toolCalls = assistantMessage.toolCalls;

      agentLog('ASSISTANT', {
        finishReason: choice.finishReason,
        hasToolCalls: !!toolCalls?.length,
        textPreview:
          typeof assistantMessage.content === 'string'
            ? assistantMessage.content.slice(0, 200)
            : undefined,
      });

      if (choice.finishReason === 'tool_calls' && toolCalls?.length) {
        // Execute each tool call and collect results
        const toolResults: ToolResponseMessage[] = await Promise.all(
          toolCalls.map(async (tc: ChatMessageToolCall) => {
            toolCallsExecuted++;
            let result: string;
            try {
              const args = JSON.parse(tc.function.arguments);
              result = await executeToolCall(tc.function.name, args);
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            return {
              role: 'tool' as const,
              content: result,
              toolCallId: tc.id,
            };
          })
        );

        // Add tool results to messages
        messages.push(...(toolResults as unknown as Message[]));
        continue;
      }

      // finish_reason is 'stop' or 'length' — return the final text
      const content = assistantMessage.content;
      const finalText = typeof content === 'string' ? content : '';
      return { response: finalText, turnsUsed, toolCallsExecuted, exhausted: false };
    }

    // Max turns exhausted — ask the model to summarize what it has so far
    messages.push({
      role: 'user',
      content:
        'You have run out of turns. Please summarize your findings so far in a concise note. Do NOT call any tools — just respond with your summary text.',
    } as UserMessage);

    const summaryResponse = await client.chat.send({
      model,
      messages,
      maxTokens,
      temperature,
      provider: { allowFallbacks: true },
    });

    const summaryContent = summaryResponse.choices?.[0]?.message?.content;
    const summaryText = typeof summaryContent === 'string' ? summaryContent : '';

    return { response: summaryText, turnsUsed, toolCallsExecuted, exhausted: true };
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
