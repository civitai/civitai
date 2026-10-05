import { describe, expect, it } from 'vitest';

import { entityUrl } from '../entity-url';
import { reportEntityForSlug, reportEntityLabels, reportPath } from '../reports';
import { OWNED_REPORT_ENTITIES, reportEntity } from '../server/report-entities';

describe('challenge report type', () => {
  it('is reachable by its queue slug', () => {
    expect(reportEntityForSlug('challenge')).toBe('challenge');
    expect(reportPath('challenge')).toBe('/reports/challenge');
    expect(reportEntityLabels.challenge).toBe('Challenge');
  });

  it('links to the challenge page', () => {
    expect(entityUrl('https://civitai.com', 'challenge', 7)).toBe(
      'https://civitai.com/challenges/7'
    );
  });

  it('joins through ChallengeReport and is owned by createdById', () => {
    expect(reportEntity('challenge')).toMatchObject({
      reportTable: 'ChallengeReport',
      fk: 'challengeId',
      table: 'Challenge',
      ownerColumn: 'createdById',
    });
    expect(OWNED_REPORT_ENTITIES.map((e) => e.type)).toContain('challenge');
  });
});
