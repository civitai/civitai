import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { BaseModelLicense } from '~/components/Model/ModelVersions/BaseModelLicense';
import { baseModelLicenses, getDisplayedBaseModelLicense } from '~/server/common/constants';

const H3_PUBLIC = 'MiniMax H3 Community License Agreement';
const H3_HEADLINE = 'Licensed to Civitai under agreement with MiniMax';

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

// The headline as rendered: the first element after the "License:" label.
function headline(html: string) {
  return html.match(/License:<\/p>\s*<(?:p|a)[^>]*>([^<]*)</)?.[1];
}

describe('base-model license shown on the model page', () => {
  it('headlines Civitai’s agreement for a base model it covers', () => {
    expect(headline(render('MiniMax H3'))).toBe(H3_HEADLINE);
  });

  it('keeps the public licence linked, as the terms for self-hosted use', () => {
    const html = render('MiniMax H3');
    const selfHosted = html.match(
      /Self-hosted use:<\/p>\s*<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/
    );
    expect(selfHosted?.[2]).toBe(H3_PUBLIC);
    expect(selfHosted?.[1]).toBe(baseModelLicenses['MiniMax H3']!.url);
  });

  it('does not link the agreement headline when it has no public page', () => {
    expect(render('MiniMax H3')).not.toMatch(new RegExp(`<a[^>]*>${H3_HEADLINE}</a>`));
  });

  it('shows the public licence unchanged for a base model it does not cover', () => {
    const html = render('Flux.1 D');
    expect(headline(html)).toBe('FLUX.1 [dev] Non-Commercial License');
    expect(html).toContain(`href="${baseModelLicenses['Flux.1 D']!.url}"`);
    expect(html).not.toContain('Self-hosted use:');
    expect(html).not.toContain('agreement with');
  });

  it('carries the notice through for a covered base model', () => {
    expect(getDisplayedBaseModelLicense('MiniMax H3')?.notice).toBe(
      baseModelLicenses['MiniMax H3']!.notice
    );
  });

  it('renders nothing after the label for a base model with no licence', () => {
    expect(getDisplayedBaseModelLicense('Other')).toBeUndefined();
    expect(headline(render('Other'))).toBeUndefined();
  });
});
