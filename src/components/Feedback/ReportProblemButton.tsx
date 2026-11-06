import { Button } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { FeedbackDrawerProps } from '~/components/Feedback/FeedbackDrawer';
import {
  FEEDBACK_ORCHESTRATOR_ID_PATTERN,
  FEEDBACK_PATH_MAX_LENGTH,
  FEEDBACK_TOAST_TEXT_MAX_LENGTH,
  ORCHESTRATION_FEEDBACK_AREA,
  SITE_BUG_REPORT_AREA,
} from '~/shared/constants/feedback.constants';
import { parseErrorRef } from '~/utils/feedback/errorRef';
import { trpc } from '~/utils/trpc';

const FeedbackDrawer = dynamic(() => import('~/components/Feedback/FeedbackDrawer'), {
  ssr: false,
});

export type ReportProblem = {
  /**
   * Set by a caller that knows the failure is the orchestrator's (generation, training). Never
   * inferred from the error text. Left unset, the report is a site bug report.
   */
  area?: typeof ORCHESTRATION_FEEDBACK_AREA;
  workflowId?: string;
  jobId?: string;
};

type Props = ReportProblem & {
  title?: string;
  /** The server-fault reference; read from `message` when not given. */
  errorRef?: string;
  /** The text the reporter was shown; its server ref, if any, is read from it. */
  message: string;
  /** Called when the drawer opens, so the toast can close itself. */
  onOpen?: () => void;
};

const clip = (text: string) => text.slice(0, FEEDBACK_TOAST_TEXT_MAX_LENGTH);
// The schema rejects a malformed id, and with it the whole report, so one is dropped here instead.
const validId = (id?: string) => (id && FEEDBACK_ORCHESTRATOR_ID_PATTERN.test(id) ? id : undefined);

/**
 * "Report this" for an error toast or alert: opens the bug-report drawer with what the reporter
 * was shown and the ids triage looks it up by.
 *
 * Toasts render above the session provider, so this cannot read the current user; a signed-out
 * caller's `getArea` fails and the button stays hidden, which is right — the drawer cannot submit
 * without a session.
 */
export function ReportProblemButton({
  area,
  workflowId,
  jobId,
  title,
  message,
  errorRef = parseErrorRef(message),
  onOpen,
}: Props) {
  // `retryOnMount: false`: a signed-out failure is not cached as data, so without it every new
  // toast would send the same refused request again.
  const queryOptions = { retry: false, retryOnMount: false, staleTime: 5 * 60 * 1000 } as const;
  const requested = trpc.feedback.getArea.useQuery(
    { area: ORCHESTRATION_FEEDBACK_AREA },
    { ...queryOptions, enabled: area === ORCHESTRATION_FEEDBACK_AREA }
  );
  const fallback = trpc.feedback.getArea.useQuery({ area: SITE_BUG_REPORT_AREA }, queryOptions);

  // An orchestration report whose area is off still files, as a site bug, with its ids.
  const target =
    area && requested.data?.enabled
      ? area
      : fallback.data?.enabled
      ? SITE_BUG_REPORT_AREA
      : undefined;
  if (!target) return null;

  const open = () => {
    onOpen?.();
    const ids = { workflowId: validId(workflowId), jobId: validId(jobId) };
    const props: FeedbackDrawerProps = {
      area: target,
      title: 'Report this problem',
      intro:
        'Tell us what you were doing. The error you just saw is attached, so we can look it up.',
      context: {
        path: window.location.pathname.slice(0, FEEDBACK_PATH_MAX_LENGTH),
        ...(errorRef ? { errorRef } : {}),
        ...(ids.workflowId ? { workflowId: ids.workflowId } : {}),
        ...(ids.jobId ? { jobId: ids.jobId } : {}),
        toast: { ...(title ? { title: clip(title) } : {}), message: clip(message) },
      },
    };
    dialogStore.trigger({ component: FeedbackDrawer, props });
  };

  return (
    <Button
      size="compact-xs"
      variant="subtle"
      color="gray"
      leftSection={<IconFlag size={14} />}
      onClick={open}
      className="mt-1"
    >
      Report this
    </Button>
  );
}
