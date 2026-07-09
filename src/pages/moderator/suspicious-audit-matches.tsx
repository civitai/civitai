import {
  Badge,
  Button,
  Code,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

type SuspiciousMatch = {
  odometer: number;
  userId: number;
  prompt: string;
  negativePrompt?: string;
  check: string;
  matchedText: string;
  regex?: string;
  context?: string;
  flaggedBy: number;
  flaggedAt: string;
};

function HighlightedPrompt({
  text,
  highlight,
  regexPattern,
}: {
  text: string;
  highlight?: string;
  regexPattern?: string;
}) {
  const containerClass =
    'max-h-48 overflow-auto whitespace-pre-wrap rounded border border-solid border-gray-3 bg-gray-0 p-2 text-sm dark:border-dark-4 dark:bg-dark-6';

  if (!text) {
    return <div className={containerClass}>{text}</div>;
  }

  let matchedText: string | null = null;
  if (highlight && text.toLowerCase().includes(highlight.toLowerCase())) {
    matchedText = highlight;
  }
  if (!matchedText && regexPattern) {
    try {
      const patternRegex = new RegExp(regexPattern, 'gi');
      const match = patternRegex.exec(text);
      if (match) matchedText = match[0];
    } catch {
      // invalid regex, ignore
    }
  }

  if (!matchedText) return <div className={containerClass}>{text}</div>;

  const escapedMatch = matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const splitRegex = new RegExp(`(${escapedMatch})`, 'gi');
  const parts = text.split(splitRegex);

  return (
    <div className={containerClass}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-yellow-3 px-0.5 text-black dark:bg-yellow-5">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </div>
  );
}

function MatchCard({ entry }: { entry: SuspiciousMatch }) {
  return (
    <div className="rounded border border-solid border-gray-3 p-4 dark:border-dark-4">
      <div className="grid grid-cols-[300px_1fr] gap-4">
        <div className="flex flex-col gap-2">
          <Group gap="xs">
            <Badge size="sm" variant="light">
              User {entry.userId}
            </Badge>
            <Badge size="sm" variant="light" color="red">
              {entry.check}
            </Badge>
          </Group>
          <div>
            <Text size="xs" fw={500} c="dimmed">
              Matched Text
            </Text>
            <Code className="text-sm">{entry.matchedText}</Code>
          </div>
          {entry.regex && (
            <div>
              <Text size="xs" fw={500} c="dimmed">
                Regex Pattern
              </Text>
              <Tooltip label={entry.regex} multiline w={500}>
                <Code className="block max-w-[250px] truncate text-xs">
                  {entry.regex.length > 50 ? entry.regex.substring(0, 50) + '...' : entry.regex}
                </Code>
              </Tooltip>
            </div>
          )}
          <div>
            <Text size="xs" fw={500} c="dimmed">
              Flagged
            </Text>
            <Text size="xs">
              by {entry.flaggedBy} · {formatDate(entry.flaggedAt, 'MMM D, YYYY h:mma')}
            </Text>
          </div>
          {entry.context && (
            <div>
              <Text size="xs" fw={500} c="dimmed">
                Context
              </Text>
              <Text size="xs" c="dimmed">
                {entry.context}
              </Text>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-2">
            <Text size="xs" fw={500} c="dimmed" mb={4}>
              Prompt
            </Text>
            <HighlightedPrompt
              text={entry.prompt}
              highlight={entry.matchedText}
              regexPattern={entry.regex}
            />
          </div>
          {entry.negativePrompt && (
            <div>
              <Text size="xs" fw={500} c="dimmed" mb={4}>
                Negative Prompt
              </Text>
              <HighlightedPrompt
                text={entry.negativePrompt}
                highlight={entry.matchedText}
                regexPattern={entry.regex}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SuspiciousAuditMatchesPage() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch, isRefetching } =
    trpc.userRestriction.getSuspiciousMatches.useQuery(undefined, {
      refetchOnWindowFocus: false,
    });

  const clearMutation = trpc.userRestriction.clearSuspiciousMatches.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ title: 'Cleared', message: 'All suspicious matches removed.' });
      await utils.userRestriction.getSuspiciousMatches.invalidate();
    },
    onError: (err) => showErrorNotification({ title: 'Error', error: new Error(err.message) }),
  });

  const handleClear = () => {
    openConfirmModal({
      title: 'Clear suspicious matches',
      children: (
        <Text size="sm">
          This will remove all flagged suspicious matches from Redis. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Clear all', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => clearMutation.mutate(),
    });
  };

  const matches = (data?.matches ?? []) as SuspiciousMatch[];

  const handleDownload = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      count: matches.length,
      matches: matches.map((m) => ({
        flaggedAt: m.flaggedAt,
        flaggedBy: m.flaggedBy,
        userId: m.userId,
        check: m.check,
        matchedText: m.matchedText,
        regex: m.regex,
        context: m.context,
        odometer: m.odometer,
        prompt: m.prompt,
        negativePrompt: m.negativePrompt,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `suspicious-audit-matches-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Meta title="Suspicious Audit Matches" deIndex />
      <Container size="xl">
        <Stack gap="lg">
          <div className="sticky top-0 z-10 -mx-4 bg-white px-4 py-3 dark:bg-dark-7">
            <Group justify="space-between">
              <div>
                <Title order={1}>Suspicious Audit Matches</Title>
                <Text size="sm" c="dimmed">
                  Entries flagged via &quot;Flag as suspicious&quot; from the prompt audit tools.
                </Text>
              </div>
              <Group>
                <Button
                  leftSection={<IconRefresh size={16} />}
                  variant="light"
                  onClick={() => refetch()}
                  loading={isRefetching}
                >
                  Refresh
                </Button>
                <Button
                  leftSection={<IconDownload size={16} />}
                  variant="light"
                  onClick={handleDownload}
                  disabled={matches.length === 0}
                >
                  Download JSON
                </Button>
                <Button
                  leftSection={<IconTrash size={16} />}
                  color="red"
                  variant="light"
                  onClick={handleClear}
                  loading={clearMutation.isPending}
                  disabled={matches.length === 0}
                >
                  Clear all
                </Button>
              </Group>
            </Group>
            <Divider mt="md" />
          </div>

          {isLoading ? (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          ) : matches.length === 0 ? (
            <Text c="dimmed" ta="center" py="xl">
              No suspicious matches flagged.
            </Text>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                Showing {matches.length} flagged matches (most recent first, capped at 1000).
              </Text>
              <Stack gap="md">
                {matches.map((entry, i) => (
                  <MatchCard key={`${entry.flaggedAt}-${i}`} entry={entry} />
                ))}
              </Stack>
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}

export default Page(SuspiciousAuditMatchesPage, { subNav: null });
