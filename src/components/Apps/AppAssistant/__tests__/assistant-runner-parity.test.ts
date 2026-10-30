import { describe, expect, it } from 'vitest';
import { isAppAssistantModel } from '@civitai/app-assistant';
import {
  APP_ASSISTANT_CHAT_CONFIG,
  APP_ASSISTANT_CONTEXT_BUDGET_TOKENS,
  APP_ASSISTANT_MAX_STEPS,
} from '~/components/Apps/AppAssistant/assistantChatConfig';
// The runner is a standalone app and cannot import the page; its defaults are pinned to the page's
// here, so a reply costs and remembers the same whichever side runs it.
import {
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_MAX_STEPS,
} from '../../../../../apps/assistant-runner/src/defaults';

describe('App Assistant reply budgets, page and server runner', () => {
  it('match', () => {
    expect(DEFAULT_MAX_STEPS).toBe(APP_ASSISTANT_MAX_STEPS);
    expect(DEFAULT_CONTEXT_BUDGET_TOKENS).toBe(APP_ASSISTANT_CONTEXT_BUDGET_TOKENS);
  });
});

describe('App Assistant models, page and server runner', () => {
  // The runner refuses a start naming a model it does not offer (`isAppAssistantModel`, which its
  // `server.ts` passes as `acceptsModel`): every model the page's button offers, the default first,
  // must be one it takes, and the button must offer nothing else.
  it('the page offers only models the runner takes, its default included', () => {
    const offered = [
      APP_ASSISTANT_CHAT_CONFIG.model,
      ...APP_ASSISTANT_CHAT_CONFIG.models.map((model) => model.id),
    ];
    expect(offered.filter((id) => !isAppAssistantModel(id))).toEqual([]);
    // The operator's list (each id checked against OpenRouter's public model list): the default,
    // then one each of GLM Flash, Claude Haiku and DeepSeek.
    expect(offered).toEqual([
      'openai/gpt-6-luna',
      'openai/gpt-6-luna',
      'z-ai/glm-5.3-flash',
      'anthropic/claude-haiku-5.5',
      'deepseek/deepseek-v4.1-flash',
    ]);
    expect(APP_ASSISTANT_CHAT_CONFIG.modelsOnly).toBe(true);
    expect(isAppAssistantModel('someone/unlisted-model')).toBe(false);
  });
});
