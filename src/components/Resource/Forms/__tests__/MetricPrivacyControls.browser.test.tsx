import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { z } from 'zod';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import type { MetricPrivacyAccess } from '~/components/Resource/Forms/MetricPrivacyControls';
import { MetricPrivacyControls } from '~/components/Resource/Forms/MetricPrivacyControls';
import { inheritedMetricPrivacy } from '~/components/Resource/Forms/metric-privacy-hints';
import { Form, useForm } from '~/libs/form';
import {
  getMetricVisibilityChoices,
  metricVisibilityChoicesSchema,
} from '~/server/utils/model-metric-privacy';

const schema = z.object({ meta: z.object({ metricVisibility: metricVisibilityChoicesSchema }) });

function Harness({
  storedMeta,
  access = 'owner',
}: {
  storedMeta?: unknown;
  access?: MetricPrivacyAccess;
}) {
  const form = useForm({
    schema,
    defaultValues: { meta: { metricVisibility: getMetricVisibilityChoices(storedMeta) } },
  });
  const choices = form.watch('meta.metricVisibility');
  return (
    <Form form={form}>
      <MetricPrivacyControls
        level="model"
        access={access}
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
  test('shows each metric’s effective state while it inherits', async () => {
    renderWithProviders(<Harness />);

    await expect
      .element(page.getByTestId('metric-privacy-effective-downloads'))
      .toHaveTextContent('hidden');
    await expect
      .element(page.getByTestId('metric-privacy-effective-buzz'))
      .toHaveTextContent('shown');
    await expect
      .element(page.getByTestId('metric-privacy-select-buzz'))
      .toHaveValue('Inherit from account');
  });

  test('an override to show is written to the form and flips the effective state', async () => {
    renderWithProviders(<Harness />);

    await userEvent.click(page.getByTestId('metric-privacy-select-downloads'));
    await userEvent.click(page.getByRole('option', { name: 'Show for this model' }));

    await expect.element(page.getByTestId('choices')).toHaveTextContent('"downloads":"show"');
    await expect
      .element(page.getByTestId('metric-privacy-effective-downloads'))
      .toHaveTextContent('shown');
  });

  test('a stored legacy hide opens as an override already set', async () => {
    renderWithProviders(<Harness storedMeta={{ hideBuzz: true }} />);

    await expect
      .element(page.getByTestId('metric-privacy-effective-buzz'))
      .toHaveTextContent('hidden');
    await expect
      .element(page.getByTestId('metric-privacy-select-buzz'))
      .toHaveValue('Hide for this model');
  });

  test('an owner without a membership gets the sentence and no controls', async () => {
    renderWithProviders(<Harness access="owner-inactive" />);

    await expect
      .element(page.getByTestId('metric-privacy-model'))
      .toHaveTextContent('active Creator Program membership');
    expect(page.getByTestId('metric-privacy-select-buzz').query()).toBeNull();
  });

  test('a moderator gets live controls', async () => {
    renderWithProviders(<Harness access="moderator" />);

    await userEvent.click(page.getByTestId('metric-privacy-select-buzz'));
    await userEvent.click(page.getByRole('option', { name: 'Hide for this model' }));
    await expect.element(page.getByTestId('choices')).toHaveTextContent('"buzz":"hide"');
  });
});
