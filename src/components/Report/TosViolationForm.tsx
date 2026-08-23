import { Radio, Stack } from '@mantine/core';
import { createReportForm } from '~/components/Report/create-report-form';
import { InputRadioGroup, InputTextArea } from '~/libs/form';
import {
  REAL_PERSON_VIOLATION,
  TOS_VIOLATIONS,
  reportTosViolationDetailsSchema,
} from '~/server/schema/report.schema';

export const TosViolationForm = createReportForm({
  schema: reportTosViolationDetailsSchema,
  Element: ({ context }) => {
    const violation = context.form.watch('violation');
    const realPerson = violation === REAL_PERSON_VIOLATION;

    return (
      <>
        <InputRadioGroup name="violation" label="Violation" withAsterisk>
          <Stack>
            {TOS_VIOLATIONS.map((value) => (
              <Radio key={value} value={value} label={value} />
            ))}
          </Stack>
        </InputRadioGroup>
        {realPerson && (
          <InputTextArea
            name="comment"
            label="Who is this?"
            withAsterisk
            placeholder="Name of the person or any additional information related to them"
          />
        )}
      </>
    );
  },
});
