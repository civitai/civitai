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
    // 🔴 The protocol guard's OWN case. The `javascript:` one above never reaches it — that URL
    // parses to an empty hostname and dies on the host allowlist — so without this row the
    // protocol line could be deleted with the whole suite still green. Measured.
    ['a non-http scheme on the real host', 'ftp://app.clickup.com/t/868kfwm3j'],
    ['empty', ''],
    ['undefined', undefined],
    ['null', null],
    ['prose', 'see the clickup task'],
  ])('refuses %s', (_label, input) => {
    expect(isClickupTaskUrl(input)).toBe(false);
  });

  /**
   * 🔴 THE POSITION-BLIND CASES. Each of these has a `t` segment and an id-shaped LAST segment, so
   * a "contains `t` and parses to something" gate accepts all three — while the id the matcher
   * reads back is the third element of each row below, none of which is the task. Stored, they
   * render as working links and can never be matched by the webhook.
   *
   * The expected wrong id is a PARAMETER rather than prose precisely so it cannot go stale: an
   * earlier draft of this sentence named a value the table no longer used.
   */
  it.each([
    ['a task sub-tab', 'https://app.clickup.com/t/868kfwm3j/subtasks', 'subtasks'],
    ['a task inside a view URL', 'https://app.clickup.com/9011/v/li/900/t/868kfwm3j/x', 'x'],
    [
      'a marketing page that happens to contain /t/',
      'https://www.clickup.com/blog/t/how-to-do',
      'how-to-do',
    ],
  ])('refuses %s, whose last segment is not the task id', (_label, input, wrongId) => {
    // The matcher reads the WRONG id out of it — which is precisely why the gate must refuse it.
    expect(clickupTaskIdFromUrl(input)).toBe(wrongId);
    expect(isClickupTaskUrl(input)).toBe(false);
  });

  /**
   * 🔴 A CUSTOM TASK ID IS A DOCUMENTED SILENT NON-CLOSURE, so the gate refuses it while the
   * matcher — which reads rows written before this gate existed — still tolerates it. Recorded
   * when the webhook shipped: deliveries carry ClickUp's internal task id, so an entry linked by
   * `DEV-1234` never matches and never closes, with no error anywhere.
   */
  it('refuses a custom task id, which the matcher still reads', () => {
    const url = 'https://app.clickup.com/t/8459928/DEV-1234';
    expect(clickupTaskIdFromUrl(url)).toBe('DEV-1234');
    expect(isClickupTaskUrl(url)).toBe(false);
  });

  /**
   * ⚠️ THE TWO PLACES THE GATE IS KNOWINGLY LOOSER THAN ITS OWN PROSE, pinned so they are visible
   * as decisions rather than discovered later as bugs. Both are documented at the DEFINITION site,
   * in `isClickupTaskUrl` — not at any call site, which is where an earlier wording sent readers.
   *
   * 1. A separator-less custom id passes the charset rule — the code refuses the DOCUMENTED
   *    `PREFIX-number` format, not provably every custom id.
   * 2. A truncated paste of a team id passes the 2-segment branch, because refusing it needs the
   *    premise "a native task id is never purely numeric", which is unverified.
   *
   * These assertions will FAIL if either is later tightened — which is the point: the change
   * should be deliberate, and should come with the evidence these paragraphs say is missing.
   */
  it('accepts a separator-less id, the documented limit of the charset rule', () => {
    expect(isClickupTaskUrl('https://app.clickup.com/t/8459928/ABC123')).toBe(true);
  });

  it('accepts a bare numeric segment, the documented limit of the 2-segment branch', () => {
    expect(isClickupTaskUrl('https://app.clickup.com/t/8459928')).toBe(true);
  });
});
