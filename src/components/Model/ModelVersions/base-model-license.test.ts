import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { BaseModelLicense } from '~/components/Model/ModelVersions/BaseModelLicense';
import { baseModelLicenses, getDisplayedBaseModelLicense } from '~/server/common/constants';

const H3_PUBLIC = 'MiniMax H3 Community License Agreement';
const ON_CIVITAI = 'On Civitai (generation, training, sharing LoRAs):';

function render(baseModel: string) {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(BaseModelLicense, {
        license: getDisplayedBaseModelLicense(baseModel),
        plural: false,
      })
    )
  );
}

// The element right after the "License:" label, when one sits on the label's row.
function inlineLicense(html: string) {
  return html.match(/License:<\/p>\s*<(?:p|a)[^>]*>([^<]*)</)?.[1];
}

// The element right after a scope label, and its href when it is a link.
function scoped(html: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp(`>${escaped}</p>\\s*<(p|a)([^>]*)>([^<]*)<`));
  if (!m) return undefined;
  return { text: m[3], href: m[1] === 'a' ? m[2].match(/href="([^"]*)"/)?.[1] : undefined };
}

describe('base-model license shown on the model page', () => {
  describe('a base model Civitai covers under its own agreement (H3)', () => {
    const html = render('MiniMax H3');

    it('states the agreement for use on Civitai, unlinked', () => {
      expect(scoped(html, ON_CIVITAI)).toEqual({
        text: 'covered by Civitai’s agreement with MiniMax',
        href: undefined,
      });
    });

    it('states the public licence for downloaded weights, linked', () => {
      expect(scoped(html, 'Downloaded weights:')).toEqual({
        text: H3_PUBLIC,
        href: baseModelLicenses['MiniMax H3']!.url,
      });
    });

    it('puts neither scope on the label’s row, so neither reads as the headline', () => {
      expect(inlineLicense(html)).toBeUndefined();
    });

    it('keeps the territory caveat in place of the notice the two lines replace', () => {
      const notice = getDisplayedBaseModelLicense('MiniMax H3')?.notice ?? '';
      expect(notice).toContain('excludes the European Union');
      expect(notice).not.toBe(baseModelLicenses['MiniMax H3']!.notice);
    });
  });

  it('shows the public licence unchanged for a base model it does not cover', () => {
    const html = render('Flux.1 D');
    expect(inlineLicense(html)).toBe('FLUX.1 [dev] Non-Commercial License');
    expect(html).toContain(`href="${baseModelLicenses['Flux.1 D']!.url}"`);
    expect(html).not.toContain('Downloaded weights:');
    expect(getDisplayedBaseModelLicense('Flux.1 D')?.notice).toBe(
      baseModelLicenses['Flux.1 D']!.notice
    );
  });

  it('renders nothing after the label for a base model with no licence', () => {
    expect(getDisplayedBaseModelLicense('Other')).toBeUndefined();
    const html = render('Other');
    expect(html).toContain('License:');
    expect(inlineLicense(html)).toBeUndefined();
  });
});
