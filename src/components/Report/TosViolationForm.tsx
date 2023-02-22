import { Radio } from '@mantine/core';
import { createReportForm } from '~/components/Report/create-report-form';
import { InputRadioGroup } from '~/libs/form';
import { reportTosViolationDetailsSchema } from '~/server/schema/report.schema';

const violations = [
  'Actual person displayed in NSFW context',
  'Graphic Violence',
  'False impersonation',
  'Deceptive content',
  'Sale of illegal substances',
  'Child abuse and exploitation',
  'Prohibited prompts',
];

export const TosViolationForm = createReportForm({
  schema: reportTosViolationDetailsSchema,
  Element: () => (
    <>
      <InputRadioGroup name="violation" label="Violation" withAsterisk orientation="vertical">
        {violations.map((value, index) => (
          <Radio key={index} value={value} label={value} />
        ))}
      </InputRadioGroup>
    </>
  ),
});
