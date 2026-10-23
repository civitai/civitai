import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { useRouter } from 'next/router';

import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import {
  SandboxApiError,
  SandboxSeedNotAppliedError,
  isRunningLimit,
} from '~/components/Apps/AppAssistant/sandboxClient';
import type { SandboxesState } from '~/components/Apps/AppAssistant/useSandboxes';
import { AppError } from '~/components/Apps/AppAssistant/YourApps';
import { forkAssistantHref } from '~/components/Apps/ForkAppAction';
import {
  FORK_CREATE_FAILED_MESSAGE,
  FORK_CREATING_MESSAGE,
  FORK_QUERY_PARAM,
  FORK_SEED_ERRORS_WITHOUT_RETRY,
  FORK_SEED_ERROR_MESSAGES,
  FORK_SESSION_MISSING_MESSAGE,
  FORK_SETUP_BUTTON,
  FORK_TRY_AGAIN_LABEL,
  type ForkSeedErrorCode,
  forkSetupPrompt,
} from '~/shared/constants/app-fork.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * FORKABLE APPS — the App Assistant side of a fork (`/apps/assistant?fork=<slug>`).
 *
 *   1. Read the caller's fork session (`appListings.getForkSession`): the parent's name and the
 *      seed `appListings.startFork` built.
 *   2. Once the user's app list has loaded: an app already under that slug is simply opened (a
 *      reload, another tab); otherwise the app is CREATED WITH THE SEED through the sandbox
 *      service, before any reply — so in both reply modes (browser and server runner) the
 *      assistant finds an app that already holds the forked files.
 *   3. The page opens a NEW chat on it and shows a card — "Forked from {parent}. Set it up and
 *      preview?" — whose one button sends one fixed message as the user's. Nothing is sent, and
 *      no Buzz is spent, until the user presses it.
 *
 * Failures are shown in place with the service's reason in the user's words, and, where a fresh
 * fork can help, a Try again that starts one (deleting a `seed_lost` app first: it is empty and
 * counts against the apps the user can keep).
 */

/** What went wrong with the fork, as the card shows it. */
export type ForkProblem =
  | { kind: 'seed'; code: ForkSeedErrorCode; sandboxName: string | null }
  | { kind: 'limit'; error: unknown }
  | { kind: 'missing' }
  | { kind: 'failed' };

type ForkParent = { parentName: string; parentListingId: string };

/** The fork slug in the page's address, when it is one. */
function forkSlugFromQuery(value: unknown): string | null {
  return typeof value === 'string' && isAppBlockId(value) ? value : null;
}

function seedErrorCode(error: unknown): ForkSeedErrorCode | null {
  const code =
    error instanceof SandboxApiError || error instanceof SandboxSeedNotAppliedError
      ? error.code
      : null;
  return code && code in FORK_SEED_ERROR_MESSAGES ? (code as ForkSeedErrorCode) : null;
}

export interface AppForkOptions {
  sandboxes: SandboxesState;
  /** The app open on the page. */
  active: Sandbox | null;
  /**
   * The fork's app exists (`fresh`: just created with its files) — the page opens it, and on a
   * fresh one starts a new chat.
   */
  onOpened: (sandbox: Sandbox, fresh: boolean) => void;
}

export function useAppFork({ sandboxes, active, onOpened }: AppForkOptions) {
  const router = useRouter();
  const forkSlug = forkSlugFromQuery(router.query[FORK_QUERY_PARAM]);
  const session = trpc.appListings.getForkSession.useQuery(
    { forkSlug: forkSlug ?? '' },
    { enabled: !!forkSlug, retry: false }
  );

  const handled = useRef(new Set<string>());
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<(ForkProblem & { app: string }) | null>(null);
  const [parent, setParent] = useState<(ForkParent & { app: string }) | null>(null);
  const [setup, setSetup] = useState<{ app: string; parentName: string } | null>(null);
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;

  /** Drop `?fork=` from the address, so a reload does not try to create the app again. */
  const clearQuery = useCallback(() => {
    if (!(FORK_QUERY_PARAM in router.query)) return;
    const query = Object.fromEntries(
      Object.entries(router.query).filter(([key]) => key !== FORK_QUERY_PARAM)
    );
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  }, [router]);

  const list = sandboxes.list.data;
  // Read through a ref inside the effect: the mutations are new objects on every render.
  const sandboxesRef = useRef(sandboxes);
  sandboxesRef.current = sandboxes;
  useEffect(() => {
    if (!forkSlug || handled.current.has(forkSlug)) return;
    if (!session.isFetched || !list) return;
    handled.current.add(forkSlug);
    clearQuery();
    const app = forkSlug;
    const data = session.data ?? null;
    if (data)
      setParent({ app, parentName: data.parentName, parentListingId: data.parentListingId });
    const existing = list.find((s) => s.app === app);
    if (existing) return onOpenedRef.current(existing, false);
    if (!data) return setProblem({ app, kind: 'missing' });
    if (!data.seed) return setProblem({ app, kind: 'missing' });
    setProblem(null);
    setCreating(true);
    sandboxesRef.current.seed.mutate(
      { app, seed: data.seed },
      {
        onSuccess: ({ sandbox }) => {
          setCreating(false);
          setSetup({ app, parentName: data.parentName });
          onOpenedRef.current(sandbox, true);
        },
        onError: (error) => {
          setCreating(false);
          // Made meanwhile (another tab, a double load): open it.
          if (error instanceof SandboxApiError && error.code === 'already_exists') {
            void sandboxesRef.current.list.refetch().then(({ data: fresh }) => {
              const found = fresh?.find((s) => s.app === app);
              if (found) onOpenedRef.current(found, false);
              else setProblem({ app, kind: 'failed' });
            });
            return;
          }
          const code = seedErrorCode(error);
          if (code)
            return setProblem({
              app,
              kind: 'seed',
              code,
              sandboxName:
                error instanceof SandboxSeedNotAppliedError ? error.sandbox?.name ?? null : null,
            });
          if (error instanceof SandboxApiError && error.kind === 'limit' && !isRunningLimit(error))
            return setProblem({ app, kind: 'limit', error });
          setProblem({ app, kind: 'failed' });
        },
      }
    );
  }, [forkSlug, session.isFetched, session.data, list, clearQuery]);

  // An app whose seed never landed: the service reports it on the list, at any time after.
  const lostApp = active?.state === 'seed_lost' ? active.app : null;
  const lostSession = trpc.appListings.getForkSession.useQuery(
    { forkSlug: lostApp ?? '' },
    { enabled: !!lostApp && parent?.app !== lostApp, retry: false }
  );

  // Try again: a fresh fork of the same parent (a new slug), after deleting an empty app.
  const restart = trpc.appListings.startFork.useMutation({
    onSuccess: ({ forkSlug: next }) =>
      void router.push(forkAssistantHref(next), undefined, { shallow: true }),
    onError: (error) =>
      showErrorNotification({ title: 'Couldn’t fork this app', error: { message: error.message } }),
  });
  const restartMutate = restart.mutate;
  const tryAgain = useCallback(
    (parentListingId: string, deleteName: string | null) => {
      setProblem(null);
      const start = () => restartMutate({ listingId: parentListingId });
      if (deleteName) sandboxesRef.current.remove.mutate(deleteName, { onSuccess: start });
      else start();
    },
    [restartMutate]
  );

  let shown: ForkProblem | null = null;
  let shownApp: string | null = null;
  if (lostApp && active) {
    shown = { kind: 'seed', code: 'seed_lost', sandboxName: active.name };
    shownApp = lostApp;
  } else if (problem) {
    shown = problem;
    shownApp = problem.app;
  }
  const shownParent =
    shownApp && parent?.app === shownApp
      ? parent.parentListingId
      : shownApp && shownApp === lostApp
      ? lostSession.data?.parentListingId ?? null
      : null;

  return {
    creating,
    problem: shown,
    /** Try again, when a fresh fork can help and the parent is known. */
    retry:
      shown && shownParent && canRetry(shown)
        ? () => tryAgain(shownParent, shown?.kind === 'seed' ? shown.sandboxName : null)
        : null,
    retrying: restart.isPending,
    setup,
    dismissSetup: useCallback(() => setSetup(null), []),
  };
}

function canRetry(problem: ForkProblem): boolean {
  if (problem.kind === 'seed') return !FORK_SEED_ERRORS_WITHOUT_RETRY.includes(problem.code);
  return problem.kind === 'failed' || problem.kind === 'missing';
}

/** The fork's status, errors and Try again, above the chat. */
export function ForkStatus({
  creating,
  problem,
  retry,
  retrying,
}: Pick<ReturnType<typeof useAppFork>, 'creating' | 'problem' | 'retry' | 'retrying'>) {
  if (creating)
    return (
      <Group gap="xs" data-testid="app-fork-creating">
        <Loader size="xs" />
        <Text size="sm">{FORK_CREATING_MESSAGE}</Text>
      </Group>
    );
  if (!problem) return null;
  // The keep-limit has its own message, the same one the rest of the page shows.
  if (problem.kind === 'limit') return <AppError error={problem.error} />;
  const message =
    problem.kind === 'seed'
      ? FORK_SEED_ERROR_MESSAGES[problem.code]
      : problem.kind === 'missing'
      ? FORK_SESSION_MISSING_MESSAGE
      : FORK_CREATE_FAILED_MESSAGE;
  return (
    <Alert color="red" variant="light" data-testid="app-fork-problem">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">{message}</Text>
        {retry && (
          <Button
            size="compact-sm"
            variant="light"
            color="red"
            className="min-h-11"
            loading={retrying}
            onClick={retry}
          >
            {FORK_TRY_AGAIN_LABEL}
          </Button>
        )}
      </Group>
    </Alert>
  );
}

/**
 * The empty-chat card on a fresh fork. Set up sends one fixed message as the user's; it is off
 * until the app runs with its tools, so the message never goes without them.
 */
export function ForkSetupCard({
  parentName,
  ready,
  onSetUp,
}: {
  parentName: string;
  ready: boolean;
  onSetUp: () => void;
}) {
  return (
    <Paper withBorder radius="md" p="md" data-testid="app-fork-setup">
      <Stack gap="sm">
        <Text size="sm">{forkSetupPrompt(parentName)}</Text>
        <Group justify="flex-end">
          <Button className="min-h-11" disabled={!ready} onClick={onSetUp}>
            {FORK_SETUP_BUTTON}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
