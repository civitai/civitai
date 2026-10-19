import { describe, expect, it } from 'vitest';
import {
  APP_ASSISTANT_CHAT_CONFIG,
  APP_ASSISTANT_EXAMPLES,
} from '~/components/Apps/AppAssistant/assistantChatConfig';

describe('App Assistant chat config', () => {
  // A wire value: the orchestrator routes this id to OpenRouter. The chat test proves the request uses it.
  it('defaults App Assistant to GPT-6 Luna', () => {
    expect(APP_ASSISTANT_CHAT_CONFIG.model).toBe('openai/gpt-6-luna');
  });

  it('offers four starter apps, each with a title and a prompt', () => {
    expect(APP_ASSISTANT_EXAMPLES).toHaveLength(4);
    for (const example of APP_ASSISTANT_EXAMPLES) {
      expect(example.title.trim()).not.toBe('');
      expect(example.prompt.trim()).not.toBe('');
    }
  });

  // The old first example used nothing a Civitai app offers.
  it('no longer offers the tip calculator', () => {
    const tip = APP_ASSISTANT_EXAMPLES.filter((example) =>
      /tip calculator/i.test(`${example.title} ${example.prompt}`)
    );
    expect(tip).toEqual([]);
  });
});
