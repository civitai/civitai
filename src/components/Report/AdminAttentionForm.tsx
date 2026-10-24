import React from 'react';
import { useWatch } from 'react-hook-form';
import { MERGE_PERMISSION_REPORT_REASON } from '@civitai/shared/merge-permission';
import { createReportForm } from './create-report-form';
import { useReportTarget } from './report-target.context';
import { InputRadioGroup, InputText, InputTextArea } from '~/libs/form';
import { reportAdminAttentionDetailsSchema } from '~/server/schema/report.schema';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { Radio, Stack } from '@mantine/core';

const reasons = [
  'Potential security concern',
  'Content that should be reviewed',
  'Incorrect or misrepresented content',
  'Other concern',
];

export const AdminAttentionForm = createReportForm({
  schema: reportAdminAttentionDetailsSchema,
  Element: ({ context }) => {
    const target = useReportTarget();
    const isModel = target?.entityType === ReportEntity.Model;
    const reason = useWatch({ control: context.form.control, name: 'reason' });

    return (
      <>
        <InputRadioGroup name="reason" label="Reason" withAsterisk>
          <Stack pt="xs" gap="lg">
            {(isModel ? [...reasons, MERGE_PERMISSION_REPORT_REASON] : reasons).map(
              (value, index) => (
                <Radio key={index} value={value} label={value} />
              )
            )}
          </Stack>
        </InputRadioGroup>
        {isModel && reason === MERGE_PERMISSION_REPORT_REASON && (
          <InputText
            name="sourceModelId"
            label="Your model"
            description="A link to the model of yours this merge uses. We check what its permissions were when the merge was published."
            placeholder="https://civitai.com/models/..."
            withAsterisk
          />
        )}
        <InputTextArea name="comment" label="Comment (optional)" />
      </>
    );
  },
});
