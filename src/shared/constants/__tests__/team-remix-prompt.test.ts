import { describe, expect, it } from 'vitest';
import { BIRTHDAY_2026_TEAMS } from '~/shared/constants/birthday2026.constants';
import { TEAM_REMIX_PROMPT, teamRemixApp } from '~/shared/constants/remix-apps.constants';
import { auditPrompt } from '~/utils/metadata/audit';

// `checkProfanity` is on for civitai.com (green) and off for .red; the prompt must pass both.
const DOMAINS = [
  ['civitai.com', true],
  ['civitai.red', false],
] as const;

describe('team remix prompt vs the prompt audit', () => {
  it.each(
    BIRTHDAY_2026_TEAMS.flatMap((team) => DOMAINS.map(([domain, green]) => [team, domain, green]))
  )('passes for Team %s on %s', (team, _domain, green) => {
    const { prompt } = teamRemixApp(team as string);
    expect(prompt).toContain(`Team ${team}`);
    expect(auditPrompt(prompt, undefined, green as boolean)).toMatchObject({ success: true });
  });

  // Control: the wording this prompt replaced. If this passes, the audit above proves nothing.
  it('refuses the old "4th Birthday" wording', () => {
    const old = TEAM_REMIX_PROMPT.replace(
      'a Civitai anniversary party',
      'a Civitai 4th Birthday celebration'
    ).replaceAll('{{team}}', 'Pink');
    expect(old).toContain('Civitai 4th Birthday celebration');
    expect(auditPrompt(old).success).toBe(false);
  });
});
