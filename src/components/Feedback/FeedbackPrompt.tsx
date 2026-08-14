import { ActionIcon, Button, Divider, Group, Paper, Text, Textarea } from '@mantine/core';
import { IconAlertTriangle, IconX } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import { FEEDBACK_MESSAGE_MAX_LENGTH } from '~/shared/constants/feedback.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const cardStyle: CSSProperties = {
  background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
  boxShadow: 'light-dark(0 1px 3px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.5))',
};

const dismissKey = (area: FeedbackArea) => `feedback-dismissed-${area}`;

// Storage access throws outright in a sandboxed iframe or with storage disabled,
// and this renders inside the feed — an unguarded read would take the whole page
// to the error boundary to save one banner.
function readDismissed(area: FeedbackArea) {
  try {
    return window.sessionStorage.getItem(dismissKey(area)) === 'true';
  } catch {
    return false;
  }
}

function writeDismissed(area: FeedbackArea) {
  try {
    window.sessionStorage.setItem(dismissKey(area), 'true');
  } catch {
    // Dismissal is then per-mount rather than per-tab.
  }
}

type FeedbackPromptProps = {
  area: FeedbackArea;
  notice: string;
  placeholder?: string;
  /** Extra detail stored alongside the message so a one-line report is still actionable. */
  context?: CreateFeedbackInput['context'];
  /** Caller's own condition — e.g. "BitDex actually served this page". */
  active?: boolean;
};

export function FeedbackPrompt({
  area,
  notice,
  placeholder = 'What looked wrong?',
  context,
  active = true,
}: FeedbackPromptProps) {
  const currentUser = useCurrentUser();
  const [dismissed, setDismissed] = useState(() => readDismissed(area));
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const enabled = active && !!currentUser && !dismissed;
  const { data } = trpc.feedback.getArea.useQuery({ area }, { enabled });

  const createFeedback = trpc.feedback.create.useMutation({
    onSuccess: () => setSent(true),
    onError: (error) =>
      showErrorNotification({ title: 'Feedback not sent', error: new Error(error.message) }),
  });

  if (!enabled || !data?.enabled) return null;

  const handleClose = () => {
    if (open && !sent) {
      setOpen(false);
      return;
    }
    writeDismissed(area);
    setDismissed(true);
  };

  return (
    <Paper withBorder radius="md" style={cardStyle}>
      <Group p="sm" justify="space-between" align="center" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" align="center" style={{ flex: 1, minWidth: 0 }}>
          <IconAlertTriangle size={16} className="text-yellow-500" style={{ flexShrink: 0 }} />
          <Text size="sm">{sent ? `Got it, thanks. We'll take a look.` : notice}</Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {!open && !sent && (
            <Button size="compact-sm" radius="xl" variant="light" onClick={() => setOpen(true)}>
              Give feedback
            </Button>
          )}
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={handleClose}
            aria-label={open && !sent ? 'Cancel feedback' : 'Dismiss'}
          >
            <IconX size={16} />
          </ActionIcon>
        </Group>
      </Group>
      {open && !sent && (
        <>
          <Divider />
          <Group p="sm" gap="xs" align="flex-start" wrap="nowrap">
            <Textarea
              style={{ flex: 1, minWidth: 0 }}
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
              placeholder={placeholder}
              maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
              autosize
              minRows={1}
              maxRows={6}
              autoFocus
              styles={{
                input: {
                  background:
                    'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))',
                },
              }}
            />
            <Button
              // `sm` is 36px, matching a one-row `sm` Textarea; compact does not.
              size="sm"
              radius="xl"
              style={{ flexShrink: 0 }}
              disabled={!message.trim()}
              // Mantine's disabled fill is near-invisible on this card surface.
              classNames={{
                root: 'data-[disabled]:!bg-blue-6 data-[disabled]:!text-white data-[disabled]:!opacity-50',
              }}
              loading={createFeedback.isPending}
              onClick={() => createFeedback.mutate({ area, message: message.trim(), context })}
            >
              Send feedback
            </Button>
          </Group>
        </>
      )}
    </Paper>
  );
}
