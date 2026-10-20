import { describe, expect, it } from 'vitest';
import {
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
