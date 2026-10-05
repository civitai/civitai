import { describe, expect, it } from 'vitest';

import type { EcosystemSeoConfig } from '~/shared/constants/ecosystem-seo.constants';
import {
  ECOSYSTEM_SEO,
  LORA_COUNT_TOKEN,
  getLoraCountKeys,
} from '~/shared/constants/ecosystem-seo.constants';

/**
 * The ecosystem pages' <title> and meta description are the search snippet. Google cuts titles
 * around 60 characters and descriptions around 155–160, so anything past that is invisible — and
 * both fields embed live LoRA counts, so their length is only known after the tokens resolve.
 */

// The page renders a count as `${formatCount(n)}+`: "7K+", "197K+", "1.2M+". Five characters is
// the widest it gets below a billion, so size every token at five.
const WIDEST_COUNT = '999K+';
const resolveWidest = (value: string) => value.replace(LORA_COUNT_TOKEN, WIDEST_COUNT);

const configs = Object.values(ECOSYSTEM_SEO) as EcosystemSeoConfig[];
const withTitle = configs.filter((c) => c.seoTitle);

describe('ecosystem SEO meta', () => {
  it('has at least one page using a custom title, so the checks below run', () => {
    expect(withTitle.length).toBeGreaterThan(0);
  });

  it.each(withTitle.map((c) => [c.key, c.seoTitle as string]))(
    '%s title fits the SERP once counts resolve',
    (_, title) => {
      expect(resolveWidest(title).length).toBeLessThanOrEqual(60);
    }
  );

  it.each(withTitle.map((c) => [c.key, c.metaDescription]))(
    '%s description fits the SERP once counts resolve',
    (_, description) => {
      expect(resolveWidest(description).length).toBeLessThanOrEqual(160);
    }
  );

  it('only uses tokens that name a real ecosystem page', () => {
    const known = new Set(Object.keys(ECOSYSTEM_SEO));
    const unknown = configs.flatMap((c) =>
      getLoraCountKeys(c)
        .filter((key) => !known.has(key))
        .map((key) => `${c.key} → {loras:${key}}`)
    );
    expect(unknown).toEqual([]);
  });

  it('loads the counts a title or description asks for, not just the comparison table', () => {
    const config = {
      ...configs[0],
      seoTitle: 'Title with {loras:TitleOnly}',
      metaDescription: 'Description with {loras:DescriptionOnly}',
      comparison: { ...configs[0].comparison, rows: [] },
    } as EcosystemSeoConfig;

    expect(getLoraCountKeys(config)).toEqual(['TitleOnly', 'DescriptionOnly']);
  });
});
