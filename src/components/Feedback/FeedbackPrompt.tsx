import { ActionIcon, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import { FEEDBACK_MESSAGE_MAX_LENGTH } from '~/shared/constants/feedback.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const dismissKey = (area: FeedbackArea) => `feedback-dismissed-${area}`;

// Per-tab, so a dismissal survives navigation within the visit and is gone on the
// next one. Both halves are guarded: storage access THROWS outright in a sandboxed
// iframe or with storage disabled, and this renders inside the feed — an unguarded
// read would take the whole page to the error boundary to save one banner. Read
// synchronously (not in an effect) so a dismissed prompt never flashes back or
// fires its query for a frame.
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
    // Dismissal is then per-mount rather than per-tab. Not worth a failed render.
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
  // Per-tab, so a dismissal survives navigation within the visit and is gone on
  // the next one. Read through useStorage rather than window.sessionStorage
  // directly: storage access throws outright in a sandboxed iframe or with
  // storage disabled, and this renders inside the feed — a throw there takes
  // the whole page to the error boundary instead of costing one banner.
  const [dismissed, setDismissed] = useState(readDismissed(area));
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

  const handleDismiss = () => {
    writeDismissed(area);
    setDismissed(true);
  };

  return (
    <Paper withBorder p="sm" radius="md" mb="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
        <Stack gap="xs" style={{ flex: 1 }}>
          <Text size="sm">{sent ? `Got it, thanks. We'll take a look.` : notice}</Text>
          {!sent && (
            <>
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
                placeholder={placeholder}
                maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
                autosize
                minRows={2}
                maxRows={6}
              />
              <Group>
                <Button
                  size="compact-sm"
                  disabled={!message.trim()}
                  loading={createFeedback.isPending}
                  onClick={() => createFeedback.mutate({ area, message: message.trim(), context })}
                >
                  Send feedback
                </Button>
              </Group>
            </>
          )}
        </Stack>
        <ActionIcon variant="subtle" color="gray" onClick={handleDismiss} aria-label="Dismiss">
          <IconX size={16} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}
