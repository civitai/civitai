import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconMessageCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { relativeTime, type AppActivity, type AppActivityItem } from '@civitai/app-assistant';
import { humaniseScopeInvocation } from '~/components/Apps/AppActivityPanel';
import { fetchAppActivity, tellAssistantText } from '~/components/Apps/AppAssistant/appActivity';

/** How often the strip reads the activity again while it is on screen. */
export const APP_ACTIVITY_POLL_MS = 10_000;

/** True while `ref`'s element is on screen: in the viewport, not inside a hidden pane. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) =>
      setOnScreen(entries.some((entry) => entry.isIntersecting))
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

/** One item's line in the list, in words for the user; call labels are `humaniseScopeInvocation`'s. */
function itemText(item: AppActivityItem): { label: string; detail: string | null; bad: boolean } {
  switch (item.kind) {
    case 'generation':
      return {
        label: `Generation ${item.status}`,
        detail:
          item.error ??
          `${item.imageCount} image${item.imageCount === 1 ? '' : 's'}${
            item.cost !== null ? ` · ${item.cost} Buzz` : ''
          }`,
        bad: item.status === 'failed' || item.status === 'expired',
      };
    case 'call':
      return {
        label: `${humaniseScopeInvocation(item.scope, item.endpoint)}${
          item.count > 1 ? ` ×${item.count}` : ''
        }`,
        detail: item.statusCode >= 400 ? `Refused (${item.statusCode})` : null,
        bad: item.statusCode >= 400,
      };
    case 'error':
      return {
        label: item.fatal ? 'App crashed' : 'App error',
        detail: item.message,
        bad: true,
      };
  }
}

/**
 * The preview pane's "App activity" strip: the summary line and an error count, expanding to the
 * list of what the app did (generations, calls to Civitai, errors its code threw). It reads the
 * activity every {@link APP_ACTIVITY_POLL_MS} only while it is on screen (and on open), and "Tell
 * the assistant" puts a short message with the recent activity in the chat's message box for the
 * user to edit and send.
 */
export function AppActivityStrip({
  blockId,
  onTellAssistant,
  pollMs = APP_ACTIVITY_POLL_MS,
  fetchActivity = fetchAppActivity,
  now = Date.now,
}: {
  blockId: string;
  /** Puts text in the chat's message box (the chat's `compose`); never sends it. */
  onTellAssistant: (text: string) => void;
  pollMs?: number;
  fetchActivity?: (blockId: string) => Promise<AppActivity | null>;
  now?: () => number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);
  const [open, setOpen] = useState(false);
  const activity = useQuery({
    queryKey: ['app-assistant', 'app-activity', blockId],
    queryFn: () => fetchActivity(blockId),
    enabled: onScreen,
    refetchInterval: onScreen ? pollMs : false,
    // A hidden tab reads nothing; coming back reads again.
    refetchIntervalInBackground: false,
    retry: false,
  });
  const data = activity.data ?? null;
  const errors = data?.items.filter((item) => item.kind === 'error').length ?? 0;

  const toggle = () => {
    setOpen((was) => !was);
    // Opening reads it again, so the list is fresh even between polls.
    if (!open) void activity.refetch();
  };

  return (
    <div
      ref={ref}
      className="shrink-0 border-t border-solid border-gray-3 dark:border-dark-4"
      data-testid="app-activity-strip"
    >
      <Group gap="xs" px="sm" py={6} wrap="nowrap" justify="space-between">
        <UnstyledButton
          onClick={toggle}
          aria-expanded={open}
          aria-controls="app-activity-list"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 md:min-h-8"
        >
          {open ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
          <Text size="xs" fw={600} className="shrink-0">
            App activity
          </Text>
          {errors > 0 && (
            <Badge size="xs" color="red" variant="filled" data-testid="app-activity-error-count">
              {errors}
            </Badge>
          )}
          <Text size="xs" c="dimmed" truncate data-testid="app-activity-summary">
            {data
              ? data.summary
              : activity.isError
              ? 'Activity could not be read just now'
              : activity.isFetching
              ? 'Reading…'
              : 'No activity read yet'}
          </Text>
        </UnstyledButton>
        <Button
          size="compact-xs"
          variant="light"
          className="min-h-11 shrink-0 md:min-h-0"
          leftSection={<IconMessageCircle size={12} />}
          disabled={!data}
          onClick={() => data && onTellAssistant(tellAssistantText(data, now()))}
        >
          Tell the assistant
        </Button>
      </Group>
      <Collapse in={open}>
        <Stack
          id="app-activity-list"
          gap={4}
          px="sm"
          pb="sm"
          className="max-h-56 overflow-y-auto"
          data-testid="app-activity-list"
        >
          {!data || data.items.length === 0 ? (
            <Text size="xs" c="dimmed">
              Nothing in the last 2 hours.
            </Text>
          ) : (
            data.items.map((item, index) => {
              const text = itemText(item);
              return (
                <Group
                  key={`${item.kind}-${item.at}-${index}`}
                  gap="xs"
                  wrap="nowrap"
                  align="start"
                >
                  <Text size="xs" c="dimmed" className="w-20 shrink-0">
                    {relativeTime(Date.parse(item.at), now())}
                  </Text>
                  <Stack gap={0} className="min-w-0">
                    <Text size="xs" c={text.bad ? 'red' : undefined}>
                      {text.label}
                    </Text>
                    {text.detail && (
                      <Text size="xs" c="dimmed" className="break-words" lineClamp={3}>
                        {text.detail}
                      </Text>
                    )}
                  </Stack>
                </Group>
              );
            })
          )}
          {data && data.omitted > 0 && (
            <Text size="xs" c="dimmed">
              {data.omitted} older not shown
            </Text>
          )}
        </Stack>
      </Collapse>
    </div>
  );
}
