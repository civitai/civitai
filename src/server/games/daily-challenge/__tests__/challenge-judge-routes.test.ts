import { describe, expect, it } from 'vitest';
import {
  isContentRefusal,
  JUDGE_ROUTES,
  PERMISSIVE_JUDGE,
  pickJudge,
} from '~/server/games/daily-challenge/challenge-judge-routes';
import { MODEL_BUZZ_RATES } from '~/server/games/daily-challenge/generative-content';

describe('pickJudge', () => {
  it('sends SFW pairs to the cheap route and adult pairs to the permissive one', () => {
    expect(pickJudge(1)).toBe(JUDGE_ROUTES[0].model);
    expect(pickJudge(4)).toBe(JUDGE_ROUTES[0].model);
    expect(pickJudge(8)).toBe(PERMISSIVE_JUDGE);
    expect(pickJudge(32)).toBe(PERMISSIVE_JUDGE);
  });

  it('falls off the end of the table to the permissive judge rather than returning nothing', () => {
    expect(pickJudge(1024)).toBe(PERMISSIVE_JUDGE);
  });

  it('prices every routed model — an unrated one silently reads as 0 spend', () => {
    for (const route of JUDGE_ROUTES) expect(MODEL_BUZZ_RATES[route.model]).toBeDefined();
  });

  it('keeps the widest route last, so a refusal has somewhere to go', () => {
    const ceilings = JUDGE_ROUTES.map((route) => route.maxNsfwLevel);
    expect([...ceilings].sort((a, b) => a - b)).toEqual(ceilings);
    expect(PERMISSIVE_JUDGE).toBe(JUDGE_ROUTES[JUDGE_ROUTES.length - 1].model);
  });
});

describe('isContentRefusal', () => {
  it('recognises the refusal that deleted 54 of 284 entries when it went unhandled', () => {
    expect(isContentRefusal(new Error('HTTP 400: {"error":"data_inspection_failed"}'))).toBe(true);
    expect(isContentRefusal(new Error('Provider returned content_policy violation'))).toBe(true);
    expect(isContentRefusal(new Error('Inappropriate content detected'))).toBe(true);
  });

  it('does not mistake an ordinary failure for a refusal', () => {
    expect(isContentRefusal(new Error('HTTP 429: rate limited'))).toBe(false);
    expect(isContentRefusal(new Error('Failed to parse JSON from completion'))).toBe(false);
    expect(isContentRefusal(undefined)).toBe(false);
  });
});
