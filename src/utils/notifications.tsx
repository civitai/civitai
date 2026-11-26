import { Anchor, Button, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { randomId } from '@mantine/hooks';
import type { NotificationData } from '@mantine/notifications';
import { hideNotification, showNotification } from '@mantine/notifications';
import type { ComponentType } from 'react';
import { Suspense } from 'react';
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconExclamationMark,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react';
import type {
  ReportProblem,
  ReportProblemButton as ReportProblemButtonComponent,
} from '~/components/Feedback/ReportProblemButton';
import { NextLink } from '~/components/NextLink/NextLink';
import { parseErrorRef } from '~/utils/feedback/errorRef';
import { getRateLimit, withRetryText } from '~/utils/rate-limit';

let ReportProblemButton:
  | ComponentType<React.ComponentProps<typeof ReportProblemButtonComponent>>
  | undefined;

/**
 * The app shell hands over the "Report this" button. This module is imported almost everywhere,
 * including by `~/utils/trpc`, which the button needs, so it cannot import the button itself.
 * Until one is registered, toasts offer no "Report this".
 */
export function registerReportProblemButton(
  component: ComponentType<React.ComponentProps<typeof ReportProblemButtonComponent>>
) {
  ReportProblemButton = component;
}

/** A toast with a "Report this" action stays up long enough to reach it. */
const REPORTABLE_AUTO_CLOSE = 10_000;
const DEFAULT_AUTO_CLOSE = 3000;

/** A notification message with "Report this" under it; `id` is the notification's, to close it. */
export function withReportAction({
  id,
  message,
  title,
  text,
  errorRef,
  report,
}: {
  id: string;
  message: React.ReactNode;
  title?: string;
  text: string;
  errorRef?: string;
  report: ReportProblem;
}) {
  if (!ReportProblemButton) return message;
  return (
    <Stack gap={0} align="flex-start">
      <div>{message}</div>
      <Suspense fallback={null}>
        <ReportProblemButton
          {...report}
          title={title}
          message={text}
          errorRef={errorRef}
          onOpen={() => hideNotification(id)}
        />
      </Suspense>
    </Stack>
  );
}

/**
 * `report`: offer "Report this", for a caller that knows what failed (an orchestration failure
 * passes `{ area: 'orchestration', workflowId?, jobId? }`). Without it the action is offered only
 * for a masked server fault — one whose message carries a server ref — never for a validation
 * message, which a report could not help with.
 */
export function showErrorNotification({
  error,
  reason,
  title,
  autoClose,
  report,
  position,
}: {
  error: Error | { message: string } | { message: string }[];
  reason?: React.ReactNode;
  title?: string;
  autoClose?: number | false;
  report?: ReportProblem;
  /** Unset: the provider's default corner. */
  position?: NotificationData['position'];
}) {
  const message = Array.isArray(error) ? (
    <ul>
      {error.map((e, index) => (
        <li key={index}>{e.message}</li>
      ))}
    </ul>
  ) : (
    reason ?? rateLimitedMessage(error.message, getRateLimit(error))
  );

  const text = Array.isArray(error)
    ? error.map((e) => e.message).join('\n')
    : typeof reason === 'string'
    ? reason
    : error.message;
  const errorRef = Array.isArray(error) ? undefined : parseErrorRef(error.message);
  const reportable = (!!report || !!errorRef) && !!ReportProblemButton;
  const id = randomId();

  showNotification({
    id,
    icon: <IconX size={18} />,
    color: 'red',
    message: reportable
      ? withReportAction({ id, message, title, text, errorRef, report: report ?? {} })
      : message,
    title,
    autoClose: autoClose ?? (reportable ? REPORTABLE_AUTO_CLOSE : DEFAULT_AUTO_CLOSE),
    position,
  });
}

export function showSuccessNotification({
  message,
  title,
  autoClose = 3000,
}: {
  message: string | React.ReactNode;
  title?: string;
  autoClose?: number | false;
}) {
  showNotification({
    icon: <IconCheck size={18} />,
    color: 'teal',
    message,
    title,
    autoClose,
  });
}

export function showWarningNotification({
  message,
  title,
  autoClose = DEFAULT_AUTO_CLOSE,
}: {
  message: string | React.ReactNode;
  title?: string;
  autoClose?: number | false;
}) {
  showNotification({
    icon: <IconExclamationMark size={18} />,
    color: 'orange',
    message,
    title,
    autoClose,
  });
}

export function showInfoNotification({
  id,
  message,
  title,
  autoClose = 3000,
}: {
  /** Showing an id that is already on screen is a no-op, so repeats don't stack. */
  id?: string;
  message: string | React.ReactNode;
  title?: string;
  autoClose?: number | false;
}) {
  showNotification({
    id,
    icon: <IconInfoCircle size={18} />,
    color: 'blue',
    message,
    title,
    autoClose,
  });
}

export function showBuzzNotification({
  message,
  title,
  ...notificationProps
}: NotificationData & {
  message: React.ReactNode;
}) {
  showNotification({
    color: 'yellow.4',
    message: (
      <Group gap={4} wrap="nowrap" align="flex-start">
        {/* @ts-ignore: ignoring ts error cause `transparent` works on variant */}
        <ThemeIcon color={notificationProps.color ?? 'yellow.4'} variant="transparent">
          <IconBolt size={18} fill="currentColor" />
        </ThemeIcon>
        {message}
      </Group>
    ),
    // Hide title on mobile for smaller notifications
    title: (
      <Text className="hide-mobile" inherit>
        {title}
      </Text>
    ),
    ...notificationProps,
  });
}

export function showConfirmNotification({
  id,
  message,
  title = 'Please confirm your action',
  color,
  onConfirm,
  onCancel,
  autoClose = 8000,
}: {
  message: React.ReactNode;
  title?: string;
  color?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  autoClose?: number | false;
  id?: string;
}) {
  showNotification({
    id,
    color,
    message: (
      <Stack>
        {message}
        <Group justify="flex-end">
          {onCancel && (
            <Button onClick={onCancel} variant="outline" color="red">
              Cancel
            </Button>
          )}
          {onConfirm && (
            <Button color={color} variant="filled" onClick={onConfirm}>
              Confirm
            </Button>
          )}
        </Group>
      </Stack>
    ),
    title,
    autoClose,
    withCloseButton: false,
  });
}

export function showExpiredCaptchaTokenNotification({
  onRetryClick,
}: {
  onRetryClick: VoidFunction;
}) {
  showNotification({
    icon: <IconAlertTriangle size={18} />,
    color: 'yellow',
    title: 'Captcha token expired',
    message: (
      <div>
        <Text inherit>Your token expired, click the button below to reset your token</Text>
        <Button size="sm" variant="subtle" onClick={onRetryClick}>
          Reset
        </Button>
      </div>
    ),
  });
}

/** A refusal's message with when to retry, and for a plan limit, a link to where to see it. */
function rateLimitedMessage(message: string, rateLimit: ReturnType<typeof getRateLimit>) {
  const text = withRetryText(message, rateLimit);
  if (rateLimit?.kind !== 'product') return text;
  return (
    <>
      {text}{' '}
      <Anchor component={NextLink} href="/user/account/usage" inherit>
        See your usage limits
      </Anchor>
    </>
  );
}
