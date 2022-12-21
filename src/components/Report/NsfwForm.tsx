import React from 'react';
import { createReportForm } from './create-report-form';
import { InputTextArea } from '~/libs/form';
import { reportNsfwDetailsSchema } from '~/server/schema/report.schema';

export const NsfwForm = createReportForm({
  schema: reportNsfwDetailsSchema,
  Element: () => {
    return (
      <>
        <InputTextArea name="comment" label="Comment (optional)" />
      </>
    );
  },
});
