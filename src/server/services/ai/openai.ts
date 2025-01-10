import OpenAI from 'openai';
import { isProd } from '~/env/other';
import { env } from '~/env/server';

type GetJsonCompletionInput =
  Partial<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> & { retries?: number };
type CustomOpenAI = OpenAI & {
  getJsonCompletion: <T>(params: GetJsonCompletionInput) => Promise<T>;
};
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalOpenAI: CustomOpenAI | undefined;
}

function createOpenAiClient() {
  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
  });

  const customClient = client as CustomOpenAI;
  customClient.getJsonCompletion = async <T>({ retries, ...params }: GetJsonCompletionInput) => {
    if (!params.messages) throw new Error('messages is required');

    const completion = await client.chat.completions.create({
      ...defaultCompletionParams,
      ...params,
      messages: params.messages!,
    });

    const result = parseJsonBlock<T>(completion);
    if (!result) {
      const content = completion.choices[0]?.message?.content;
      console.error('Failed to parse JSON block from content', content);
      if (retries && retries > 0) {
        return customClient.getJsonCompletion<T>({ ...params, retries: retries - 1 });
      }
      throw new Error('Failed to parse JSON block from completion');
    }
    return result as T;
  };

  return customClient;
}

export let openai: CustomOpenAI | undefined;
const shouldConnect = env.OPENAI_API_KEY;
if (shouldConnect) {
  if (isProd) {
    openai = createOpenAiClient();
  } else {
    if (!global.globalOpenAI) global.globalOpenAI = createOpenAiClient();
    openai = global.globalOpenAI;
  }
}

// Helpers
// ------------------------------------
export const defaultCompletionParams: Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  'messages'
> = {
  model: 'gpt-4o-mini',
  temperature: 1,
  max_tokens: 2048,
  top_p: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
};

const jsonBlockRegex = /```json\n(.*?)\n```/s;
function parseJsonBlock<T>(completion: OpenAI.Chat.Completions.ChatCompletion) {
  const content = completion.choices[0]?.message?.content;
  // Attempt to match JSON block wrapped with ```json
  const jsonBlockMatch = content?.match(jsonBlockRegex)?.[1];
  // Determine the string to parse: matched JSON block or entire content
  const jsonString = jsonBlockMatch ?? content;
  if (!jsonString) return null;
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    return null;
  }
}
