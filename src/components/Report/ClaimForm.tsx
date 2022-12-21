import { createReportForm } from '~/components/Report/create-report-form';
import { InputText, InputTextArea } from '~/libs/form';
import { reportClaimDetailsSchema } from '~/server/schema/report.schema';

export const ClaimForm = createReportForm({
  schema: reportClaimDetailsSchema,
  Element: () => (
    <>
      <InputText name="email" label="Email" withAsterisk />
      <InputTextArea name="comment" label="Comment (optional)" />
    </>
  ),
});
