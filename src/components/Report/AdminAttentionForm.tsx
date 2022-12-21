import React from 'react';
import { createReportForm } from './create-report-form';
import { InputRadioGroup, InputTextArea } from '~/libs/form';
import { reportAdminAttentionDetailsSchema } from '~/server/schema/report.schema';
import { Radio } from '@mantine/core';

const reasons = ['security', 'bad', 'content', 'incorrect', 'data', 'other'];

export const AdminAttentionForm = createReportForm({
  schema: reportAdminAttentionDetailsSchema,
  Element: () => {
    return (
      <>
        <InputRadioGroup name="violation" label="Violation" withAsterisk orientation="vertical">
          {reasons.map((value, index) => (
            <Radio key={index} value={value} label={value} />
          ))}
        </InputRadioGroup>
        <InputTextArea name="comment" label="Comment (optional)" />
      </>
    );
  },
});
