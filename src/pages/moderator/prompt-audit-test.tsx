import {
  Badge,
  Button,
  Checkbox,
  Code,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { createSelectStore } from '~/store/select.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

type AuditMatch = {
  check: string;
  matched: boolean;
  matchedText?: string;
  regex?: string;
  context?: string;
  details?: Record<string, unknown>;
};

type AuditResult = {
  userId: number;
  prompt: string;
  negativePrompt?: string;
  source: string;
  createdDate: string;
  matches: AuditMatch[];
  wouldBlock: boolean;
  blockReason?: string;
};

type FlattenedResult = {
  result: AuditResult;
  resultIndex: number;
  matchIndex: number;
  match: AuditMatch;
  key: string;
};

// Create a select store for managing checkbox state
const { useIsSelected, toggle, setSelected, getSelected, useSelection } =
  createSelectStore<string>('prompt-audit-selection');

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

  // Find the actual matched text to highlight
  let matchedText: string | null = null;

  // First, try the literal highlight text
  if (highlight && text.toLowerCase().includes(highlight.toLowerCase())) {
    matchedText = highlight;
  }

  // If literal match didn't work and we have a regex pattern, find what it matches
  if (!matchedText && regexPattern) {
    try {
      const patternRegex = new RegExp(regexPattern, 'gi');
      const match = patternRegex.exec(text);
      if (match) {
        matchedText = match[0]; // Use the actual matched text, not the pattern
      }
    } catch {
      // Invalid regex, ignore
    }
  }

  // If nothing matched, just render plain text
  if (!matchedText) {
    return <div className={containerClass}>{text}</div>;
  }

  // Now split using the literal matched text (escaped for regex)
  const escapedMatch = matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const splitRegex = new RegExp(`(${escapedMatch})`, 'gi');
  const parts = text.split(splitRegex);

  return (
    <div className={containerClass}>
      {parts.map((part, i) =>
        // When splitting with a single capturing group, matched parts are at odd indices
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

function FlagSuspiciousButton({
  resultsByKey,
  isMounted,
}: {
  resultsByKey: Map<string, FlattenedResult>;
  isMounted: boolean;
}) {
  const selectedKeys = useSelection();

  const saveMutation = trpc.userRestriction.saveSuspiciousMatches.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({
        title: 'Saved',
        message: `${data.savedCount} suspicious matches saved for review.`,
      });
      setSelected([]);
    },
    onError: (err) => {
      showErrorNotification({ title: 'Error', error: new Error(err.message) });
    },
  });

  const handleSaveSelected = () => {
    const matches = getSelected()
      .map((key) => resultsByKey.get(key))
      .filter((item): item is FlattenedResult => !!item)
      .map((item) => ({
        odometer: item.resultIndex,
        userId: item.result.userId,
        prompt: item.result.prompt,
        negativePrompt: item.result.negativePrompt,
        check: item.match.check,
        matchedText: item.match.matchedText ?? '',
        regex: item.match.regex,
        context: item.match.context,
      }));

    saveMutation.mutate({ matches });
  };

  // Only show count after mount to avoid hydration mismatch
  const count = isMounted ? selectedKeys.length : 0;

  return (
    <Button
      leftSection={<IconAlertTriangle size={16} />}
      color="yellow"
      onClick={handleSaveSelected}
      loading={saveMutation.isPending}
      disabled={count === 0}
      style={{ visibility: count === 0 ? 'hidden' : 'visible' }}
    >
      Flag {count} Suspicious
    </Button>
  );
}

function AuditMatchCard({ item, isMounted }: { item: FlattenedResult; isMounted: boolean }) {
  const { result, match, key } = item;
  const rawIsSelected = useIsSelected(key);
  // Only show selection state after mount to avoid hydration mismatch
  const isSelected = isMounted && rawIsSelected;

  return (
    <div
      className={`rounded border border-solid p-4 ${
        isSelected
          ? 'border-yellow-5 bg-yellow-1 dark:border-yellow-7 dark:bg-yellow-9/20'
          : 'border-gray-3 dark:border-dark-4'
      }`}
    >
      <div className="grid grid-cols-[300px_1fr] gap-4">
        {/* Left side - Match info */}
        <div className="flex flex-col gap-2">
          <Checkbox checked={isSelected} onChange={() => toggle(key)} label="Flag as suspicious" />
          <Group gap="xs">
            <Badge size="sm" variant="light">
              User {result.userId}
            </Badge>
            <Badge size="sm" variant="light" color="red">
              {match.check}
            </Badge>
          </Group>
          <div>
            <Text size="xs" fw={500} c="dimmed">
              Matched Text
            </Text>
            <Code className="text-sm">{match.matchedText}</Code>
          </div>
          {match.regex && (
            <div>
              <Text size="xs" fw={500} c="dimmed">
                Regex Pattern
              </Text>
              <Tooltip label={match.regex} multiline w={500}>
                <Code className="block max-w-[250px] truncate text-xs">
                  {match.regex.length > 50 ? match.regex.substring(0, 50) + '...' : match.regex}
                </Code>
              </Tooltip>
            </div>
          )}
          {match.details && Object.keys(match.details).length > 0 && (
            <div>
              <Text size="xs" fw={500} c="dimmed">
                Details
              </Text>
              <Text size="xs" c="dimmed">
                {JSON.stringify(match.details)}
              </Text>
            </div>
          )}
        </div>

        {/* Right side - Prompts */}
        <div className="min-w-0">
          <div className="mb-2">
            <Text size="xs" fw={500} c="dimmed" mb={4}>
              Prompt
            </Text>
            <HighlightedPrompt
              text={result.prompt}
              highlight={match.matchedText}
              regexPattern={match.regex}
            />
          </div>
          {result.negativePrompt && (
            <div>
              <Text size="xs" fw={500} c="dimmed" mb={4}>
                Negative Prompt
              </Text>
              <HighlightedPrompt
                text={result.negativePrompt}
                highlight={match.matchedText}
                regexPattern={match.regex}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PromptAuditTestPage() {
  // Track mount state to avoid hydration mismatch with selection state
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setSelected([]);
    setIsMounted(true);
  }, []);

  const {
    data: auditData,
    isLoading,
    refetch,
    isRefetching,
  } = trpc.userRestriction.getTodaysAuditResults.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  const { data: userCountsData, refetch: refetchUserCounts } =
    trpc.userRestriction.getTodaysUserCounts.useQuery(undefined, {
      refetchOnWindowFocus: false,
    });

  // Flatten results to show one card per match
  const flattenedResults = useMemo(() => {
    const results: FlattenedResult[] = [];
    if (auditData?.results) {
      for (let ri = 0; ri < auditData.results.length; ri++) {
        const result = auditData.results[ri];
        for (let mi = 0; mi < result.matches.length; mi++) {
          const key = `${ri}-${mi}`;
          results.push({
            result,
            resultIndex: ri,
            matchIndex: mi,
            match: result.matches[mi],
            key,
          });
        }
      }
    }
    return results;
  }, [auditData?.results]);

  // Build a map of key -> flattened result for saving
  const resultsByKey = useMemo(() => {
    const map = new Map<string, FlattenedResult>();
    for (const item of flattenedResults) {
      map.set(item.key, item);
    }
    return map;
  }, [flattenedResults]);

  const userCounts = userCountsData?.userCounts ?? [];

  return (
    <>
      <Meta title="Prompt Audit Test" deIndex />
      <Container size="xl">
        <Stack gap="lg">
          {/* Sticky header */}
          <div className="sticky top-0 z-10 -mx-4 bg-white px-4 py-3 dark:bg-dark-7">
            <Group justify="space-between">
              <div>
                <Title order={1}>Prompt Audit Test</Title>
                <Text size="sm" c="dimmed">
                  Review today&apos;s prohibited prompts and identify suspicious regex matches.
                </Text>
              </div>
              <Group>
                <Button
                  leftSection={<IconRefresh size={16} />}
                  variant="light"
                  onClick={() => {
                    refetch();
                    refetchUserCounts();
                  }}
                  loading={isRefetching}
                >
                  Refresh
                </Button>
                <FlagSuspiciousButton resultsByKey={resultsByKey} isMounted={isMounted} />
              </Group>
            </Group>
            <Divider mt="md" />
          </div>

          {isLoading ? (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          ) : (
            <Tabs defaultValue="matches">
              <Tabs.List>
                <Tabs.Tab value="matches">Matches ({flattenedResults.length})</Tabs.Tab>
                <Tabs.Tab value="by-user">By User ({userCounts.length})</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="matches" pt="md">
                {flattenedResults.length === 0 ? (
                  <Text c="dimmed" ta="center" py="xl">
                    No audit matches found for today&apos;s prohibited prompts.
                  </Text>
                ) : (
                  <>
                    <Text size="sm" c="dimmed" mb="md">
                      Showing {flattenedResults.length} matches from{' '}
                      {auditData?.results.length ?? 0} prohibited prompts today. Select suspicious
                      matches to flag for review.
                    </Text>
                    <Stack gap="md">
                      {flattenedResults.map((item) => (
                        <AuditMatchCard key={item.key} item={item} isMounted={isMounted} />
                      ))}
                    </Stack>
                  </>
                )}
              </Tabs.Panel>

              <Tabs.Panel value="by-user" pt="md">
                {userCounts.length === 0 ? (
                  <Text c="dimmed" ta="center" py="xl">
                    No prohibited prompts found for today.
                  </Text>
                ) : (
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>User ID</Table.Th>
                        <Table.Th style={{ textAlign: 'right' }}>Prohibited Prompts</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {userCounts.map(({ userId, count }) => (
                        <Table.Tr key={userId}>
                          <Table.Td>{userId}</Table.Td>
                          <Table.Td style={{ textAlign: 'right' }}>{count}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Tabs.Panel>
            </Tabs>
          )}
        </Stack>
      </Container>
    </>
  );
}

export default Page(PromptAuditTestPage, { subNav: null });
