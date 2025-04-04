import React from 'react';
import { createReportForm } from './create-report-form';
import { InputRadioGroup, InputTextArea } from '~/libs/form';
import { reportAdminAttentionDetailsSchema } from '~/server/schema/report.schema';
import { Radio } from '@mantine/core';
import { useDomainSettings } from '~/providers/DomainSettingsProvider';

const reasons = [
  'Potential security concern',
  'Content that should be reviewed',
  'Incorrect or misrepresented content',
  'Other concern',
];

export const AdminAttentionForm = createReportForm({
  schema: reportAdminAttentionDetailsSchema,
  Element: () => {
    const domainSettings = useDomainSettings();
    const { appendedAdminAttentionReasons } = domainSettings;
    return (
      <>
        <InputRadioGroup name="reason" label="Reason" withAsterisk orientation="vertical">
          {[...reasons, ...(appendedAdminAttentionReasons ?? [])].map((value, index) => (
            <Radio key={index} value={value} label={value} />
          ))}
        </InputRadioGroup>
        <InputTextArea name="comment" label="Comment (optional)" />
      </>
    );
  },
});
