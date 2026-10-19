import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { z } from 'zod';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import { MetricPrivacyControls } from '~/components/Resource/Forms/MetricPrivacyControls';
import { inheritedMetricPrivacy } from '~/components/Resource/Forms/metric-privacy-hints';
import { Form, useForm } from '~/libs/form';
import {
  getMetricVisibilityChoices,
  metricVisibilityChoicesSchema,
} from '~/server/utils/model-metric-privacy';

const schema = z.object({ meta: z.object({ metricVisibility: metricVisibilityChoicesSchema }) });

function Harness({ storedMeta }: { storedMeta?: unknown }) {
  const form = useForm({
    schema,
    defaultValues: { meta: { metricVisibility: getMetricVisibilityChoices(storedMeta) } },
  });
  const choices = form.watch('meta.metricVisibility');
  return (
    <Form form={form}>
      <MetricPrivacyControls
        level="model"
        inherited={inheritedMetricPrivacy({
          level: 'model',
          userSettings: { hideModelDownloads: true },
          isOwner: true,
        })}
      />
      <div data-testid="choices">{JSON.stringify(choices)}</div>
    </Form>
  );
}

describe('MetricPrivacyControls', () => {
  test('shows what each metric inherits, with the override collapsed', async () => {
    renderWithProviders(<Harness />);

    await expect
      .element(page.getByTestId('metric-privacy-inherited-downloads'))
      .toHaveTextContent('Hidden, from your account default');
    await expect
      .element(page.getByTestId('metric-privacy-inherited-buzz'))
      .toHaveTextContent('Shown, from your account default');
    await expect
      .element(page.getByTestId('metric-privacy-override-toggle-model'))
      .toHaveTextContent('Override for this model');
  });

  test('an override to show is written to the form and replaces the inherited line', async () => {
    renderWithProviders(<Harness />);

    await userEvent.click(page.getByTestId('metric-privacy-override-toggle-model'));
    const downloads = page.getByRole('radiogroup').nth(1);
    await userEvent.click(downloads.getByText('Show', { exact: true }));

    await expect.element(page.getByTestId('choices')).toHaveTextContent('"downloads":"show"');
    await expect
      .element(page.getByTestId('metric-privacy-inherited-downloads'))
      .toHaveTextContent('Shown, overridden for this model');
  });

  test('a stored legacy hide opens as an override already set', async () => {
    renderWithProviders(<Harness storedMeta={{ hideBuzz: true }} />);

    await expect
      .element(page.getByTestId('metric-privacy-override-toggle-model'))
      .toHaveTextContent('Override for this model (1)');
    await expect
      .element(page.getByTestId('metric-privacy-inherited-buzz'))
      .toHaveTextContent('Hidden, overridden for this model');
  });
});
