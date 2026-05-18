import { createReportForm } from './create-report-form';
import { InputTextArea } from '~/libs/form';
import { reportSpamDetailsSchema } from '~/server/schema/report.schema';

export const SpamForm = createReportForm({
  schema: reportSpamDetailsSchema,
  Element: () => (
    <InputTextArea
      name="comment"
      label="Comment (optional)"
      placeholder="Anything that helps moderators triage (link, account behavior, repeated posts, etc.)"
    />
  ),
});
