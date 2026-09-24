import { describe, expect, it } from 'vitest';
import { clickupTaskIdFromUrl, isClickupTaskUrl } from '../clickup-url';

/**
 * The ONE parser two apps share. The main app's ClickUp webhook uses it to decide WHICH board entry
 * a completed task closes; the moderator app uses it to refuse a pasted URL that could never be
 * matched. A disagreement between those two readings is silent in the worst way — the entry stores
 * a link that looks correct on screen, the webhook never matches it, and the issue simply never
 * auto-closes with nothing reporting a failure.
 *
 * Every expectation below is a hand-written literal. Deriving one from the regex would make the
 * test agree with whatever the implementation happens to say.
 */
describe('clickupTaskIdFromUrl', () => {
  it('reads the id off a canonical task URL', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/8459928/868kfwm3j')).toBe('868kfwm3j');
  });

  it('reads the id off the short task URL form', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/868kfwm3j')).toBe('868kfwm3j');
  });

  it('keeps a custom task id, which carries a hyphen', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/8459928/DEV-1234')).toBe('DEV-1234');
  });

  it('keeps an underscore, which a custom id may also carry', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/TEAM_7')).toBe('TEAM_7');
  });

  /**
   * The three shapes a URL copied out of a browser actually arrives in. Each one used to be a
   * plausible way to store a link the matcher could not read back.
   */
  it('drops a query string', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/868kfwm3j?comment=123')).toBe(
      '868kfwm3j'
    );
  });

  it('drops a fragment', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/868kfwm3j#activity')).toBe('868kfwm3j');
  });

  it('drops any number of trailing slashes', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/868kfwm3j///')).toBe('868kfwm3j');
  });

  it('drops a query string that sits after a trailing slash', () => {
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/868kfwm3j/?a=b')).toBe('868kfwm3j');
  });

  /**
   * 🔴 THE REFUSALS ARE THE POINT. Each of these returns null from the MATCHER, so an entry stored
   * with one of them can never be closed by the webhook — which is exactly why the moderator form
   * has to refuse it at the moment it is typed rather than accepting it and going quiet.
   */
  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a bare origin, which has no task segment', 'https://app.clickup.com'],
    ['a last segment carrying a space', 'https://app.clickup.com/t/868 kfwm3j'],
    ['a last segment carrying a dot', 'https://app.clickup.com/t/868kfwm3j.json'],
  ])('returns null for %s', (_label, input) => {
    expect(clickupTaskIdFromUrl(input)).toBeNull();
  });

  /**
   * ⚠️ NOT A URL PARSER, AND THE TEST SAYS SO RATHER THAN LEAVING IT TO BE DISCOVERED. It takes the
   * last path-ish segment of whatever it is handed, so a bare id and a non-ClickUp host both parse.
   * That is deliberate — this function READS values that already exist, including rows other tools
   * wrote, and tightening it would stop matching links that work today.
   *
   * 🔴 It is ALSO why it must never be used as an INPUT gate. `isClickupTaskUrl` below is that
   * gate, and the pair of expectations in each of these two cases is the whole point: the matcher
   * accepts, the gate refuses.
   */
  it('accepts a bare id for MATCHING, which the input gate refuses', () => {
    expect(clickupTaskIdFromUrl('868kfwm3j')).toBe('868kfwm3j');
    expect(isClickupTaskUrl('868kfwm3j')).toBe(false);
  });

  it('accepts a foreign host for MATCHING, which the input gate refuses', () => {
    expect(clickupTaskIdFromUrl('https://example.com/t/868kfwm3j')).toBe('868kfwm3j');
    expect(isClickupTaskUrl('https://example.com/t/868kfwm3j')).toBe(false);
  });
});

/**
 * The INPUT gate. It exists because the matcher above is deliberately permissive, and a new write
 * path that inherited that permissiveness would be LOOSER than the board's own create form, which
 * has always required `z.url()` on this column.
 */
describe('isClickupTaskUrl', () => {
  it.each([
    ['the canonical task URL', 'https://app.clickup.com/t/8459928/868kfwm3j'],
    ['the short task URL', 'https://app.clickup.com/t/868kfwm3j'],
    ['a custom task id', 'https://app.clickup.com/t/8459928/DEV-1234'],
    ['a query string', 'https://app.clickup.com/t/868kfwm3j?comment=1'],
    ['a fragment', 'https://app.clickup.com/t/868kfwm3j#activity'],
    ['a trailing slash', 'https://app.clickup.com/t/868kfwm3j/'],
    ['the apex host', 'https://clickup.com/t/868kfwm3j'],
    ['a mixed-case host, which URL parsing normalises', 'https://App.ClickUp.com/t/868kfwm3j'],
  ])('accepts %s', (_label, input) => {
    expect(isClickupTaskUrl(input)).toBe(true);
  });

  /**
   * 🔴 THE REFUSALS ARE WHAT THIS FUNCTION IS FOR. The first two are the cases the matcher accepts
   * and the board's `z.url()` would have rejected — i.e. the regression this gate exists to stop.
   */
  it.each([
    ['a bare task id', '868kfwm3j'],
    ['a look-alike host', 'https://example.com/t/868kfwm3j'],
    ['a host merely ENDING in the real one', 'https://evil-app.clickup.com.attacker.test/t/x'],
    ['a ClickUp URL that is not a task link', 'https://app.clickup.com/868kfwm3j'],
    ['a ClickUp origin with no task', 'https://app.clickup.com/'],
    ['a non-http scheme', 'javascript:alert(1)//app.clickup.com/t/x'],
    ['empty', ''],
    ['undefined', undefined],
    ['null', null],
    ['prose', 'see the clickup task'],
  ])('refuses %s', (_label, input) => {
    expect(isClickupTaskUrl(input)).toBe(false);
  });
});
