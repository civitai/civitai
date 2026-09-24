import { describe, expect, it } from 'vitest';
import { clickupTaskIdFromUrl } from '../clickup-url';

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
   * That is deliberate — the webhook receives ids, not URLs — and it means "parses" must never be
   * read as "is a ClickUp link".
   */
  it('accepts a bare id, because the matcher compares ids rather than URLs', () => {
    expect(clickupTaskIdFromUrl('868kfwm3j')).toBe('868kfwm3j');
  });

  it('accepts a foreign host, which is why callers cannot treat this as host validation', () => {
    expect(clickupTaskIdFromUrl('https://example.com/t/868kfwm3j')).toBe('868kfwm3j');
  });
});
