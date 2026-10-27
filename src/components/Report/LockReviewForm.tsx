import { Checkbox, Loader, Stack, Text } from '@mantine/core';
import { useEffect } from 'react';
import { createReportForm } from './create-report-form';
import { useReportTarget } from './report-target.context';
import { InputCheckboxGroup, InputTextArea } from '~/libs/form';
import { reportAdminAttentionDetailsSchema } from '~/server/schema/report.schema';
import {
  LOCK_REVIEW_REPORT_REASON,
  requestableLockLabels,
} from '~/shared/constants/lock-review.constants';
import { trpc } from '~/utils/trpc';

export const LockReviewForm = createReportForm({
  schema: reportAdminAttentionDetailsSchema,
  Element: ({ context }) => {
    const target = useReportTarget();
    const { data, isLoading } = trpc.report.getLockReviewState.useQuery(
      { id: target?.entityId ?? 0 },
      { enabled: !!target?.entityId }
    );
    const requestable = data?.requestable ?? [];

    const { setValue } = context.form;
    useEffect(() => {
      setValue('reason', LOCK_REVIEW_REPORT_REASON);
      if (requestable.length === 1) setValue('lockedProperties', requestable);
    }, [setValue, requestable.join()]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
      <>
        <Text size="sm">
          A moderator has locked some of this model&apos;s settings, so you can&apos;t change them
          yourself. If you think one is wrong, tell us which and why, and a moderator will take
          another look.
        </Text>
        {isLoading ? (
          <Loader size="sm" />
        ) : (
          <InputCheckboxGroup name="lockedProperties" label="Which setting?" withAsterisk>
            <Stack pt="xs" gap="sm">
              {requestable.map((key) => (
                <Checkbox key={key} value={key} label={requestableLockLabels[key]} />
              ))}
            </Stack>
          </InputCheckboxGroup>
        )}
        <InputTextArea
          name="comment"
          label="Why should it change?"
          placeholder="Tell us what the moderator should know."
          withAsterisk
          autosize
          minRows={3}
        />
      </>
    );
  },
});
