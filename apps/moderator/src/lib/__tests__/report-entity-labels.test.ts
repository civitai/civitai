import { describe, expect, it } from 'vitest';

import { reportEntityLabels } from '../reports';

describe('report type labels', () => {
  // User lookup, the moderation board and the CSAM hold author card key their rows by label, and
  // Svelte throws on a duplicate key, so two types sharing a label break those pages outright.
  it('are unique', () => {
    const labels = Object.values(reportEntityLabels);
    expect(labels.filter((label, i) => labels.indexOf(label) !== i)).toEqual([]);
  });
});
