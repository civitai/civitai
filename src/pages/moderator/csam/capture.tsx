import {
  Alert,
  Button,
  Card,
  Container,
  NumberInput,
  Radio,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { useState } from 'react';
import * as z from 'zod';
import { isFeedbackCaptureOwner } from '@civitai/shared/feedback-capture';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  getCaptureReportContext,
  type CaptureReportContext,
} from '~/server/services/feedback-capture-report.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/** The account a CSAM report names when no user is to blame. */
const INTERNAL_SUBJECT_ID = -1;

type Choice = 'reporter' | 'user' | 'internal';

const querySchema = z.object({ imageId: z.coerce.number().int().positive() });

/**
 * Files a CSAM report on a feedback page capture. A capture can show any account's content, so no
 * subject is preselected: the moderator names one, then files on the ordinary report page.
 */
function ReportCsamCapturePage({ capture }: { capture: CaptureReportContext | null }) {
  const router = useRouter();
  const features = useFeatureFlags();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [enteredId, setEnteredId] = useState<number | null>(null);

  if (!features.csamReports) return <NotFound />;
  if (!capture)
    return (
      <Container size="sm" py="xl">
        <Alert color="red">This image is not a feedback page capture.</Alert>
      </Container>
    );

  const enteredValid =
    enteredId != null &&
    Number.isSafeInteger(enteredId) &&
    enteredId > 0 &&
    !isFeedbackCaptureOwner(enteredId);
  const subjectId =
    choice === 'reporter'
      ? capture.reporterId
      : choice === 'internal'
      ? INTERNAL_SUBJECT_ID
      : choice === 'user' && enteredValid
      ? enteredId
      : null;
  const reporterLabel = capture.reporterUsername
    ? `@${capture.reporterUsername} (#${capture.reporterId})`
    : `#${capture.reporterId}`;

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={2}>Report a feedback page capture</Title>
        <Text size="sm" c="dimmed">
          Image #{capture.imageId}
          {capture.feedbackId != null && <> · feedback report #{capture.feedbackId}</>}. A capture
          is a screenshot of a page and can show any account&apos;s content. Name the account the
          report is about.
        </Text>
        <Card withBorder>
          <Radio.Group value={choice} onChange={(value) => setChoice(value as Choice)}>
            <Stack gap="sm">
              {capture.reporterId != null && (
                <Radio
                  value="reporter"
                  label={`The reporter, ${reporterLabel}`}
                  description="Reporter, not subject: pick only if they produced the content."
                />
              )}
              <Radio
                value="user"
                label="Another account"
                description="The account whose content the capture shows, such as the owner of the content on the captured page."
              />
              {choice === 'user' && (
                <Stack gap={4} pl="xl">
                  {capture.path && (
                    <Text size="xs" c="dimmed">
                      Captured page: <code>{capture.path}</code>
                    </Text>
                  )}
                  <NumberInput
                    label="User id"
                    value={enteredId ?? ''}
                    onChange={(value) => setEnteredId(typeof value === 'number' ? value : null)}
                    min={1}
                    allowDecimal={false}
                    allowNegative={false}
                    error={enteredId != null && !enteredValid ? 'Enter a user id.' : undefined}
                  />
                </Stack>
              )}
              <Radio
                value="internal"
                label={`Internal (${INTERNAL_SUBJECT_ID})`}
                description="No account is named."
              />
            </Stack>
          </Radio.Group>
        </Card>
        <Button
          disabled={subjectId == null}
          onClick={() =>
            subjectId != null &&
            router.push(`/moderator/csam/${subjectId}?imageId=${capture.imageId}`)
          }
        >
          Continue
        </Button>
      </Stack>
    </Container>
  );
}

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  resolver: async ({ ctx }) => {
    const parsed = querySchema.safeParse(ctx.query);
    const capture = parsed.success ? await getCaptureReportContext(parsed.data.imageId) : null;
    return { props: { capture } };
  },
});

export default Page(ReportCsamCapturePage, { footer: null });
