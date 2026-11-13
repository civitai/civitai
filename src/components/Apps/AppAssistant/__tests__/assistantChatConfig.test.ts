import { describe, expect, it } from 'vitest';
import { APP_ASSISTANT_EXAMPLES } from '~/components/Apps/AppAssistant/assistantChatConfig';

describe('App Assistant starter apps', () => {
  // Reviewed copy: each prompt names an App SDK capability, so any reword is a change to re-review.
  it('offers exactly the four reviewed starters', () => {
    expect(APP_ASSISTANT_EXAMPLES).toEqual([
      {
        title: 'Character card maker',
        prompt:
          'Build a character card maker: I give a name and a few traits, it generates a portrait, and I can post the card to Civitai',
      },
      {
        title: 'LoRA tester',
        prompt:
          'Make an app where I pick a checkpoint and a LoRA from Civitai and see the same prompt generated with and without the LoRA',
      },
      {
        title: 'Daily prompt challenge',
        prompt:
          'Run a daily challenge with a new theme each day, where people generate an image for it and vote for their favourite entry',
      },
      {
        title: 'Buzz tracker',
        prompt:
          'Show my Buzz balance and recent transactions, with a chart of what I spent this week',
      },
    ]);
  });
});
