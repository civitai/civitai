import { Alert, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import { describeBuildFailure } from '~/components/Apps/buildFailure';
import type { BuildAttemptSignals } from '~/shared/constants/app-block-build.constants';

/**
 * Why an approved version failed to go live, for the APP'S OWN TEAM.
 *
 * The headline, cause and guidance come from {@link describeBuildFailure}; this component
 * only lays them out. Never render it on a moderator surface: the excerpt is the app's own
 * build output.
 *
 * RENDERING SAFETY — the excerpt is tenant-influenced build output. It is sanitized
 * server-side to printable text + newlines (`sanitizeBuildFailureReason`) AND rendered
 * here through ordinary React text interpolation, which escapes. There is deliberately no
 * `dangerouslySetInnerHTML` on this path, so even a hostile excerpt renders as literal
 * characters.
 */
export function DeployFailureDetail({
  detail,
  signals,
  testId,
}: {
  detail: string | null | undefined;
  /** The latest build attempt's failed step and class, when the build reported them. */
  signals?: BuildAttemptSignals | null;
  /** Prefix for this block's test ids; the excerpt gets `<testId>-excerpt`. */
  testId: string;
}) {
  const failure = describeBuildFailure(detail, signals);
  const isAuthors = failure.failureClass === 'author';
  return (
    <Alert
      color={isAuthors ? 'red' : 'orange'}
      variant="light"
      icon={<IconAlertTriangle size={16} />}
      title={failure.headline}
      data-testid={testId}
      data-failure-class={failure.failureClass}
    >
      <Stack gap={6}>
        {failure.failedStepLabel && (
          <Text size="sm" fw={500} data-testid={`${testId}-step`}>
            Failed at: {failure.failedStepLabel}
          </Text>
        )}
        <Text size="sm">{failure.guidance}</Text>
        {failure.excerpt && (
          // Plain <pre>, not <Code block>: the wrap, the height cap and the both-axis
          // scroll must not depend on Mantine's CSS.
          <pre
            data-testid={`${testId}-excerpt`}
            style={{
              margin: 0,
              padding: '0.5rem 0.65rem',
              borderRadius: 4,
              fontSize: '0.75rem',
              lineHeight: 1.45,
              fontFamily: 'var(--mantine-font-family-monospace, monospace)',
              background: 'var(--mantine-color-default, rgba(0,0,0,0.06))',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: '14rem',
              overflow: 'auto',
            }}
          >
            {failure.excerpt}
          </pre>
        )}
      </Stack>
    </Alert>
  );
}
