import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Center,
  CloseButton,
  Group,
  Loader,
  Paper,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconSelector } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type {
  ChatMcpServer,
  CivitaiChat,
  ReplyResumeDetail,
} from '@civitai/components-chat/civitai-chat';
import { AppAssistantChat } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantPreview } from '~/components/Apps/AppAssistant/AppAssistantPreview';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
import { NO_APP_REFUSAL, createAppTools } from '~/components/Apps/AppAssistant/appTools';
import {
  BUILD_IT_MESSAGE,
  SANDBOX_SERVER_ID,
  SET_CHECKLIST,
  createAssistantGate,
} from '~/components/Apps/AppAssistant/assistantGate';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';
import {
  AssistantTokenError,
  createAssistantTokenProvider,
} from '~/components/Apps/AppAssistant/assistantToken';
import { isDictating, messageBoxText } from '~/components/Apps/AppAssistant/chatAdapter';
import type { PreviewSession } from '~/components/Apps/AppAssistant/previewTools';
import { createPreviewTools } from '~/components/Apps/AppAssistant/previewTools';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import {
  createSandboxClient,
  isSandboxServiceUrl,
} from '~/components/Apps/AppAssistant/sandboxClient';
import { useSandboxes } from '~/components/Apps/AppAssistant/useSandboxes';
import {
  APP_STATUS,
  AppError,
  appsError,
  YourAppsList,
} from '~/components/Apps/AppAssistant/YourApps';
import { APP_ASSISTANT_DAILY_BUZZ_CAP } from '~/shared/constants/app-assistant.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import classes from './AppAssistant.module.scss';

const NO_MCP_SERVERS: ChatMcpServer[] = [];
/** The app's tools are added only once it runs, so a message sent before then would go without them. */
export const APP_STARTING_HOLD = 'Your app is starting…';

function EnableCard({
  onEnable,
  pending,
  error,
}: {
  onEnable: () => void;
  pending: boolean;
  error: unknown;
}) {
  return (
    <Center className="py-10">
      <Paper withBorder radius="md" p="xl" maw={520}>
        <Stack gap="sm">
          <Title order={3}>Turn on App Assistant</Title>
          <Text size="sm">
            Describe an app in your own words and the assistant builds it for you, in a private
            workspace of your own. It can make images and other media for your app with your Buzz,
            up to {numberWithCommas(APP_ASSISTANT_DAILY_BUZZ_CAP)} Buzz a day. You can change that
            limit or turn the assistant off at any time under connected apps in your account
            settings.
          </Text>
          {!!error && (
            <Alert color="red" variant="light">
              {error instanceof Error ? error.message : 'App Assistant could not be turned on.'}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button onClick={onEnable} loading={pending} className="min-h-11">
              Turn on App Assistant
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Center>
  );
}

/**
 * A held message comes back to the user if its app has not run by then, and a released one the chat
 * has not taken by then is reported unsent.
 */
export const HELD_TIMEOUT_MS = 3 * 60_000;

/** How long the page waits for its app list when the chat asks for a failed reply by itself. */
export const APP_LIST_REFRESH_TIMEOUT_MS = 10_000;

/**
 * A message the page is sending as the user's; `went` once the chat let it through. `wake` makes the
 * release look again at once (`stopRelease` calls it).
 */
export interface Release {
  text: string;
  went: boolean;
  wake: () => void;
}

/**
 * Ends the message the page is sending, if any. Its release then resolves as any release ends: kept
 * when the message went or a copy of it is still in the box (the user's to send), otherwise false, and
 * the caller reports it unsent. A copy left in a box hidden by dictation is taken out first.
 */
export function stopRelease(replaying: { current: Release | null }): void {
  const release = replaying.current;
  replaying.current = null;
  release?.wake();
}

/**
 * Sends `text` as the user's. A copy the chat keeps back in a box that was empty (while it holds, or
 * on a refused grant) is hidden while the user dictates, and their words would be joined to it: such a
 * copy is taken back out, so the caller can give the message back instead.
 */
async function sendNotJoined(
  chat: Pick<CivitaiChat, 'send' | 'compose'>,
  text: string,
  box: () => string,
  dictating: () => boolean,
  went: () => boolean
): Promise<void> {
  const empty = !box();
  await chat.send(text);
  if (empty && !went() && dictating() && box() === text) await chat.compose('');
}

type ReleaseChat = Pick<
  CivitaiChat,
  'send' | 'compose' | 'canSend' | 'addEventListener' | 'removeEventListener'
>;

/**
 * Sends `text` as the user's, once the chat can take it. While the chat holds (it lists a just-added
 * app's tools) or a reply runs, a send goes nowhere; the chat's `can-send-change` says when that ends,
 * and the message is sent then, once. While the chat holds, one send puts it in an EMPTY message box,
 * so the user sees it waiting. A copy in the box is the user's once they change it: nothing more is
 * sent. An untouched copy is cleared once the message went. Resolves false when the message neither
 * went nor is in the box — the user sent something else first, the chat or app changed, or the chat
 * could not take it within `timeoutMs` — so it would otherwise be lost without a word. While the user
 * dictates, the box is hidden and a copy in it would be joined to what they said: none is put in an
 * empty box then, and a copy still there when the wait runs out is cleared and the message reported
 * unsent.
 */
export async function releaseHeld(
  chatRef: { current: ReleaseChat | null },
  replaying: { current: Release | null },
  box: () => string,
  dictating: () => boolean,
  text: string,
  timeoutMs = HELD_TIMEOUT_MS
): Promise<boolean> {
  const chat = chatRef.current;
  // Set by every reason to look again, so one that comes while a send is out is not missed.
  let woken = false;
  let resume: (() => void) | undefined;
  const wake = () => {
    woken = true;
    resume?.();
  };
  const release: Release = { text, went: false, wake };
  replaying.current = release;
  const live = () => replaying.current === release && !release.went;
  let parked = false;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    wake();
  }, timeoutMs);
  chat?.addEventListener('can-send-change', wake);
  try {
    while (chat && live() && !expired) {
      woken = false;
      if (parked && box() !== text) break;
      if (chat.canSend) {
        // It goes now, or the chat took it and still kept it back (the page's before-send, a refused
        // grant): either way there is nothing more to wait for. A copy kept back under dictation is
        // taken out, and the message reported unsent.
        await sendNotJoined(chat, text, box, dictating, () => release.went);
        break;
      }
      if (!parked && !box() && !dictating()) {
        await chat.send(text);
        if (!live()) break;
        if (box() === text) parked = true;
      }
      if (!woken) await new Promise<void>((resolve) => (resume = resolve));
      resume = undefined;
    }
  } finally {
    clearTimeout(timer);
    chat?.removeEventListener('can-send-change', wake);
  }
  if (replaying.current === release) replaying.current = null;
  if (!release.went && parked && box() === text && dictating()) {
    await chatRef.current?.compose('');
    return false;
  }
  if (release.went && parked && box() === text) await chatRef.current?.compose('');
  return release.went || parked || box() === text;
}

type RetryChat = Pick<
  CivitaiChat,
  'canSend' | 'retryReply' | 'updateComplete' | 'addEventListener' | 'removeEventListener'
>;

/**
 * Asks the chat for its failed reply again (`retryReply()`), once, as soon as it can send: tools just
 * handed to it start listing in its next update, and `canSend` reads true until then, so this waits for
 * that update first. Asks nothing once `signal` aborts or the chat goes; whether it asked.
 */
export async function retryWhenReady(
  chatRef: { current: RetryChat | null },
  signal: AbortSignal
): Promise<boolean> {
  const chat = chatRef.current;
  if (!chat || signal.aborted) return false;
  let woken = false;
  let resume: (() => void) | undefined;
  const wake = () => {
    woken = true;
    resume?.();
  };
  chat.addEventListener('can-send-change', wake);
  signal.addEventListener('abort', wake);
  try {
    await chat.updateComplete;
    while (!signal.aborted && chatRef.current === chat) {
      woken = false;
      if (chat.canSend) return await chat.retryReply();
      if (!woken) await new Promise<void>((resolve) => (resume = resolve));
      resume = undefined;
    }
    return false;
  } finally {
    chat.removeEventListener('can-send-change', wake);
    signal.removeEventListener('abort', wake);
  }
}

/** What "Put it back" leaves in the message box: the message, ahead of anything typed there since. */
function putBack(message: string, box: string): string {
  return box.trim() ? `${message}\n\n${box}` : message;
}

/** The app the user worked on last, to open on a visit with none open; none when no app says when. */
export function mostRecentApp(apps: Sandbox[]): Sandbox | null {
  const at = (s: Sandbox) => Date.parse(s.lastActivityAt ?? s.createdAt ?? '') || 0;
  return apps.reduce<Sandbox | null>((best, s) => (at(s) > (best ? at(best) : 0) ? s : best), null);
}

export function AppAssistantWorkspace({
  canPreview,
  sandboxUrl,
}: {
  canPreview: boolean;
  /** The hosted sandbox service's base URL, from the server; null when not configured. */
  sandboxUrl: string | null;
}) {
  // A revoke surfaces as `consent_required` on the next mint, for any purpose; show the turn-on card
  // rather than leaving every call failing.
  const [revoked, setRevoked] = useState(false);
  const tokens = useMemo(
    () => createAssistantTokenProvider({ onConsentRequired: () => setRevoked(true) }),
    []
  );
  // Whether the user has turned the assistant on: the sandbox token mints only against their consent.
  const access = useQuery({
    queryKey: ['app-assistant', 'access'],
    queryFn: () => tokens.getToken({ purpose: 'sandbox' }),
    enabled: !!sandboxUrl,
    retry: false,
    staleTime: Infinity,
  });
  const enable = useMutation({
    mutationFn: () => tokens.enable(),
    onSuccess: () => {
      setRevoked(false);
      void access.refetch();
    },
  });
  const sandboxClient = useMemo(
    () =>
      sandboxUrl && access.isSuccess && !revoked
        ? createSandboxClient({
            baseUrl: sandboxUrl,
            getToken: (opts) => tokens.getToken({ ...opts, purpose: 'sandbox' }),
          })
        : null,
    [sandboxUrl, tokens, access.isSuccess, revoked]
  );
  const sandboxes = useSandboxes(sandboxClient);
  const apps = sandboxes.list.data ?? [];

  const [activeName, setActiveName] = useState<string | null>(null);
  const active = apps.find((s) => s.name === activeName) ?? null;
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [tab, setTab] = useState<'chat' | 'preview'>('chat');
  const shownTab = session ? tab : 'chat';
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherTitleId = useId();
  const chatRef = useRef<CivitaiChat | null>(null);
  // A message sent while the open app was paused, held until the app runs again. `started` once the
  // app was seen starting.
  type Held = { text: string; app: string; chatId: string | null; started: boolean };
  const [held, setHeld] = useState<Held | null>(null);
  // Messages of the user's that did not go and could not go back into the message box unasked.
  const [unsent, setUnsent] = useState<{ id: number; text: string }[]>([]);
  const unsentIds = useRef(0);
  const unsentId = useId();
  const offerBack = useCallback(
    (text: string) => setUnsent((list) => [...list, { id: ++unsentIds.current, text }]),
    []
  );
  const dismissUnsent = (id: number) => setUnsent((list) => list.filter((u) => u.id !== id));
  const replaying = useRef<Release | null>(null);
  const boxText = useCallback(() => messageBoxText(chatRef.current), []);
  const dictating = useCallback(() => isDictating(chatRef.current), []);
  const [chatId, setChatId] = useState<string | null>(null);
  const chatIdRef = useRef(chatId);
  const previewShown = useRef(false);
  const pickedOnLoad = useRef(false);

  const startDevTunnel = trpc.blocks.startDevTunnel.useMutation();
  const stopDevTunnel = trpc.blocks.stopDevTunnel.useMutation();

  // The chat reads tools and instructions through these on every call, so neither has to be rebuilt.
  const live = useRef({ active, session, canPreview, apps: sandboxes.list.data });
  live.current = { active, session, canPreview, apps: sandboxes.list.data };
  const stopRef = useRef(stopDevTunnel.mutateAsync);
  stopRef.current = stopDevTunnel.mutateAsync;
  const startRef = useRef(startDevTunnel.mutateAsync);
  startRef.current = startDevTunnel.mutateAsync;
  const openRef = useRef(sandboxes.open.mutateAsync);
  openRef.current = sandboxes.open.mutateAsync;

  const stopPreview = useCallback(() => {
    const current = live.current.session;
    if (!current) return;
    setSession(null);
    stopRef.current({ sessionId: current.sessionId }).catch(() => undefined);
  }, []);

  const appTools = useMemo(
    () =>
      createAppTools({
        apps: () => live.current.apps,
        current: () => live.current.active,
        open: async (app) => {
          const opened = await openRef.current(app);
          // set_checklist can arrive before the next render, so the beforeToolCall gate reads live.current.
          live.current.active = opened.sandbox;
          setActiveName(opened.sandbox.name);
          return opened;
        },
      }),
    []
  );
  const gate = useMemo(
    () =>
      createAssistantGate({
        refuse: (name) =>
          // Features are planned for an app, so not before one exists.
          name === SET_CHECKLIST && !live.current.active ? NO_APP_REFUSAL : appTools.refusal(name),
        onReply: appTools.newReply,
        onBuild: () => void buildRef.current(),
        currentApp: () => live.current.active?.name ?? null,
      }),
    [appTools]
  );
  // What was verified belongs to the sandbox it was verified in, and so does a checklist's Build it.
  useEffect(() => {
    gate.reset();
    gate.appChanged(activeName);
  }, [activeName, gate]);

  const tools = useMemo(
    () => ({
      ...createPreviewTools({
        canPreview,
        currentSandbox: () => live.current.active?.name ?? null,
        defaultBlockId: () => {
          const app = live.current.active?.app;
          return app && isAppBlockId(app) ? app : null;
        },
        startDevTunnel: (input) => startRef.current(input),
        stopDevTunnel: (input) => stopRef.current(input),
        getSession: () => live.current.session,
        setSession: (next) => {
          live.current.session = next;
          setSession(next);
          // A reconnect (the tunnel dropped) leaves the user on the tab they chose.
          if (next && !previewShown.current) {
            previewShown.current = true;
            setTab('preview');
          }
        },
      }),
      ...appTools.tools,
      ...gate.tools,
    }),
    [canPreview, gate, appTools]
  );

  const instructions = useCallback(
    () =>
      buildAssistantInstructions({
        sandbox: live.current.active,
        apps: (live.current.apps ?? []).map((s) => s.app),
        canPreview: live.current.canPreview,
        previewHost: live.current.session?.host ?? null,
      }),
    []
  );

  // The token goes only to the configured sandbox service, whatever URL a response names.
  const mcpUrl =
    active?.state === 'running' && sandboxUrl && isSandboxServiceUrl(active.mcpUrl, sandboxUrl)
      ? active.mcpUrl
      : null;
  const mcpServers = useMemo<ChatMcpServer[]>(
    () =>
      mcpUrl
        ? [
            {
              id: SANDBOX_SERVER_ID,
              url: mcpUrl,
              label: 'your app',
              token: () => tokens.getToken({ purpose: 'sandbox' }),
            },
          ]
        : NO_MCP_SERVERS,
    [mcpUrl, tokens]
  );

  // A failed reply the chat asks for again (Retry, or by itself as the page wakes) fires no before-send,
  // so a paused app would not be woken and the reply would go on without its tools. The ask is held
  // instead, the app woken, and the reply asked for once its tools are handed to the chat.
  // - `auto`: the chat asked by itself, as the page woke or came back online. The app list did not
  //   refresh while the page slept, so the page first asks for it again (`checking`) and decides on
  //   that: running with its tools, the reply is asked for; paused, the app is woken; else none.
  // - `started` once the app was seen starting; `asking` once it runs with its tools and the ask
  //   waits on the chat.
  type ResumeAsk = {
    app: string;
    chatId: string | null;
    key: string;
    auto: boolean;
    checking: boolean;
    started: boolean;
    asking: boolean;
    stop: AbortController;
  };
  const [resumeAsk, setResumeAsk] = useState<ResumeAsk | null>(null);
  const resumeAskRef = useRef(resumeAsk);
  // Per app and chat. The chat asks by itself again on every wake until it gets through: once the page
  // gave such an ask up, it keeps the next ones back and does nothing, and it wakes the app by itself
  // once at most, so it never loops. Retry, which the user presses, is always followed.
  const autoGaveUp = useRef(new Set<string>());
  const autoWoke = useRef(new Set<string>());
  const finishResumeAsk = useCallback((asked: boolean) => {
    const ask = resumeAskRef.current;
    ask?.stop.abort();
    if (ask?.auto && !asked) autoGaveUp.current.add(ask.key);
    resumeAskRef.current = null;
    setResumeAsk(null);
  }, []);
  const endResumeAsk = useCallback(() => finishResumeAsk(false), [finishResumeAsk]);
  const refetchRef = useRef(sandboxes.list.refetch);
  refetchRef.current = sandboxes.list.refetch;
  const wakeForAsk = useCallback(
    (app: string) =>
      resumeRef.current(app, {
        // Unless the user moved on meanwhile.
        onSuccess: ({ sandbox }: { sandbox: Sandbox }) => {
          if (resumeAskRef.current?.app === sandbox.app) setActiveName(sandbox.name);
        },
        onError: endResumeAsk,
      }),
    [endResumeAsk]
  );
  /** The chat asked by itself: decide on the app list as it is now, not as it was before the page slept. */
  const checkAutoAsk = useCallback(
    async (ask: ResumeAsk) => {
      // One refresh, bounded; one that fails or runs out gives the ask up.
      let fresh: Sandbox[] | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          refetchRef.current(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), APP_LIST_REFRESH_TIMEOUT_MS);
          }),
        ]);
        fresh = result.isError ? undefined : result.data;
      } catch {
        fresh = undefined;
      } finally {
        clearTimeout(timer);
      }
      if (resumeAskRef.current !== ask) return;
      const app = fresh?.find((s) => s.app === ask.app);
      const paused = app?.state === 'suspended';
      // Waking it pauses whichever other app runs: not without the user asking.
      const pausesAnother = fresh?.some((s) => s.app !== ask.app && s.state !== 'suspended');
      if (
        !app ||
        (app.state !== 'running' && !paused) ||
        (paused && (pausesAnother || autoWoke.current.has(ask.key)))
      )
        return endResumeAsk();
      resumeAskRef.current = { ...ask, checking: false };
      setResumeAsk(resumeAskRef.current);
      if (!paused) return;
      autoWoke.current.add(ask.key);
      wakeForAsk(ask.app);
    },
    [endResumeAsk, wakeForAsk]
  );
  const onReplyResume = useCallback(
    (trigger: ReplyResumeDetail['trigger']) => {
      const app = live.current.active;
      if (!app) return false;
      if (resumeAskRef.current) return true;
      const auto = trigger !== 'retry';
      // Retry: the user pressed it now, so the list is current.
      if (!auto && app.state !== 'suspended' && app.state !== 'starting') return false;
      const key = `${app.app}\n${chatIdRef.current}`;
      if (auto && autoGaveUp.current.has(key)) return true;
      const ask: ResumeAsk = {
        app: app.app,
        chatId: chatIdRef.current,
        key,
        auto,
        checking: auto,
        started: app.state === 'starting',
        asking: false,
        stop: new AbortController(),
      };
      resumeAskRef.current = ask;
      setResumeAsk(ask);
      if (auto) void checkAutoAsk(ask);
      else if (app.state === 'suspended') wakeForAsk(app.app);
      return true;
    },
    [checkAutoAsk, wakeForAsk]
  );
  useEffect(() => {
    if (!resumeAsk) return;
    // The app was closed, another opened, or another chat opened meanwhile.
    if (!active || active.app !== resumeAsk.app || chatId !== resumeAsk.chatId)
      return endResumeAsk();
    if (resumeAsk.checking) return;
    if (resumeAsk.asking) {
      if (active.state !== 'running' || !mcpServers.length) endResumeAsk();
      return;
    }
    // Paused again once it had started.
    if (active.state === 'suspended') {
      if (resumeAsk.started) endResumeAsk();
      return;
    }
    if (active.state === 'starting') {
      if (!resumeAsk.started) {
        resumeAskRef.current = { ...resumeAsk, started: true };
        setResumeAsk(resumeAskRef.current);
      }
      return;
    }
    // Running, but its tools are not handed to the chat: asking would go on without them.
    if (!mcpServers.length) return endResumeAsk();
    const asking: ResumeAsk = { ...resumeAsk, asking: true };
    resumeAskRef.current = asking;
    setResumeAsk(asking);
    void retryWhenReady(chatRef, asking.stop.signal).then((asked) => {
      if (resumeAskRef.current === asking) finishResumeAsk(asked);
    });
  }, [resumeAsk, active, chatId, mcpServers, endResumeAsk, finishResumeAsk]);
  // The app has HELD_TIMEOUT_MS to run, and the chat as long again to take the ask once it does.
  const resuming = !!resumeAsk;
  const waitingOnChat = !!resumeAsk?.asking;
  useEffect(() => {
    if (!resuming) return;
    const timer = setTimeout(endResumeAsk, HELD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [resuming, waitingOnChat, endResumeAsk]);
  useEffect(() => () => resumeAskRef.current?.stop.abort(), []);

  // A preview belongs to the sandbox it was started from; tear it down when that changes or the
  // page goes away. The tunnel also expires on its own.
  useEffect(() => {
    previewShown.current = false;
    return stopPreview;
  }, [activeName, stopPreview]);
  // `session` too: a preview start already in flight can land after the suspend or revoke.
  useEffect(() => {
    if (session && (active?.state === 'suspended' || revoked)) stopPreview();
  }, [session, active?.state, revoked, stopPreview]);
  useEffect(() => {
    if (activeName && sandboxes.list.isSuccess && !active) setActiveName(null);
  }, [activeName, active, sandboxes.list.isSuccess]);
  // A visit opens the app worked on last, once, without starting it: starting pauses the running one.
  useEffect(() => {
    if (pickedOnLoad.current || !sandboxes.list.data) return;
    pickedOnLoad.current = true;
    if (activeName) return;
    const recent = mostRecentApp(sandboxes.list.data);
    if (recent) setActiveName(recent.name);
  }, [sandboxes.list.data, activeName]);

  const resumeRef = useRef(sandboxes.open.mutate);
  resumeRef.current = sandboxes.open.mutate;
  const heldRef = useRef(held);
  heldRef.current = held;
  // A message that did not go comes back to the user, never over what they have in the box or are
  // dictating into it.
  const giveBack = useCallback(
    (text: string) => {
      const box = boxText();
      if (box === text) return;
      if (box.trim() || dictating()) offerBack(text);
      else void chatRef.current?.compose(text);
    },
    [boxText, dictating, offerBack]
  );
  // Build it: a send the chat could not take now (a reply still ending, or a hold) comes back to the
  // user to send instead, so it is never pressed twice.
  const buildWent = useRef(false);
  const buildRef = useRef(async () => {
    buildWent.current = false;
    const chat = chatRef.current;
    if (chat)
      await sendNotJoined(chat, BUILD_IT_MESSAGE, boxText, dictating, () => buildWent.current);
    if (buildWent.current) return;
    giveBack(BUILD_IT_MESSAGE);
    gate.answered();
  });
  const giveBackHeld = useCallback(() => {
    const message = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    if (message) giveBack(message.text);
  }, [giveBack]);
  const onBeforeSend = useCallback(
    (text: string) => {
      gate.answered();
      setUnsent((list) => list.filter((u) => u.text !== text));
      if (text === BUILD_IT_MESSAGE) buildWent.current = true;
      const release = replaying.current;
      if (release?.text === text) release.went = true;
      // The user sent something else: stop sending the page's message (the release reports it unsent).
      else stopRelease(replaying);
      const app = live.current.active;
      // While a message is held the chat holds too, so nothing else reaches here then.
      if (app?.state !== 'suspended' || heldRef.current) return false;
      heldRef.current = {
        text,
        app: app.app,
        chatId: chatIdRef.current,
        started: false,
      };
      setHeld(heldRef.current);
      resumeRef.current(app.app, {
        // Unless the user moved on meanwhile.
        onSuccess: ({ sandbox }: { sandbox: Sandbox }) => {
          if (heldRef.current?.app === sandbox.app) setActiveName(sandbox.name);
        },
        onError: giveBackHeld,
      });
      return true;
    },
    [gate, giveBackHeld]
  );
  // A message on its way out belongs to the chat and app it was written in, and to this page.
  useEffect(() => {
    stopRelease(replaying);
  }, [activeName, chatId]);
  useEffect(() => () => stopRelease(replaying), []);
  useEffect(() => {
    if (!held) return;
    // The app was closed, another opened, or another chat opened meanwhile.
    if (!active || active.app !== held.app || chatId !== held.chatId) return giveBackHeld();
    // Paused again once it had started (paused by hand, or from another tab).
    if (active.state === 'suspended') {
      if (held.started) giveBackHeld();
      return;
    }
    if (active.state === 'starting') {
      if (!held.started) {
        heldRef.current = { ...held, started: true };
        setHeld(heldRef.current);
      }
      return;
    }
    // Running, but its tools are not handed to the chat (an address outside the sandbox service).
    if (!mcpServers.length) return giveBackHeld();
    heldRef.current = null;
    setHeld(null);
    void releaseHeld(chatRef, replaying, boxText, dictating, held.text).then((kept) => {
      if (!kept) offerBack(held.text);
    });
  }, [held, active, chatId, mcpServers, giveBackHeld, boxText, dictating, offerBack]);
  const holding = !!held;
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(giveBackHeld, HELD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [holding, giveBackHeld]);

  const onChatChange = useCallback(
    (id: string | null) => {
      gate.answered();
      // At once, not only in the effect after the next render: the chat can say it can send before then,
      // and the message would go to the chat just opened.
      if (id !== chatIdRef.current) stopRelease(replaying);
      chatIdRef.current = id;
      setChatId(id);
    },
    [gate]
  );

  // A failed reply waiting on its app is not asked for after a message of the user's, nor in another
  // chat: at once, as the chat can say it can send before the next render.
  const onSend = useCallback(
    (text: string) => {
      endResumeAsk();
      return onBeforeSend(text);
    },
    [endResumeAsk, onBeforeSend]
  );
  const onChatOpened = useCallback(
    (id: string | null) => {
      if (id !== chatIdRef.current) endResumeAsk();
      onChatChange(id);
    },
    [endResumeAsk, onChatChange]
  );

  const starting = held || (sandboxes.open.isPending && sandboxes.open.variables === active?.app);
  const status = active && (starting ? APP_STATUS.starting : APP_STATUS[active.state]);
  // Picking a paused app starts it, which pauses the one that runs.
  const selectApp = (sandbox: Sandbox) => {
    setActiveName(sandbox.name);
    setSwitcherOpen(false);
    if (sandbox.state === 'suspended')
      sandboxes.open.mutate(sandbox.app, {
        // Unless the user moved on meanwhile; a deleted app comes back under a new name.
        onSuccess: ({ sandbox: opened }: { sandbox: Sandbox }) => {
          if (live.current.active?.app === opened.app) setActiveName(opened.name);
        },
      });
  };
  const onRemoved = (name: string) => {
    appTools.forget(name);
    if (name === activeName) setActiveName(null);
  };
  const startNewApp = () => {
    setActiveName(null);
    chatRef.current?.newChat();
    setSwitcherOpen(false);
  };

  if (!sandboxUrl)
    return (
      <Alert color="yellow" variant="light">
        App Assistant can’t build apps on this deployment yet.
      </Alert>
    );
  if (access.isPending)
    return (
      <Center className="py-10">
        <Loader size="sm" />
      </Center>
    );
  if (
    revoked ||
    (access.error instanceof AssistantTokenError && access.error.code === 'consent_required')
  )
    return (
      <EnableCard
        onEnable={() => enable.mutate()}
        pending={enable.isPending}
        error={enable.error}
      />
    );
  if (access.error)
    return (
      <Alert color="red" variant="light">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">
            {access.error instanceof Error ? access.error.message : 'App Assistant is unavailable.'}
          </Text>
          <Button
            size="compact-sm"
            variant="light"
            color="red"
            className="min-h-11"
            loading={access.isFetching}
            onClick={() => void access.refetch()}
          >
            Retry
          </Button>
        </Group>
      </Alert>
    );

  return (
    <div className={clsx('flex flex-col gap-3', classes.workspace)}>
      {(active || apps.length > 0) && (
        <Popover
          opened={switcherOpen}
          onChange={setSwitcherOpen}
          position="bottom-start"
          width="min(360px, calc(100vw - 32px))"
          trapFocus
          returnFocus
          shadow="md"
        >
          <Popover.Target>
            <UnstyledButton
              className="flex min-h-11 min-w-0 max-w-full shrink-0 items-center gap-2 self-start rounded-md px-2"
              aria-label={`Switch app: ${active ? `${active.app}, ${status}` : 'no app open'}`}
              onClick={() => setSwitcherOpen((open) => !open)}
            >
              <div className="min-w-0">
                <Text fw={600} truncate>
                  {active ? active.app : 'No app open'}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {active ? status : 'Open one of yours, or describe a new one'}
                </Text>
              </div>
              <IconSelector size={16} className="shrink-0" />
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown aria-labelledby={switcherTitleId}>
            <Text id={switcherTitleId} size="xs" fw={600} c="dimmed" tt="uppercase" mb="xs">
              Apps
            </Text>
            <YourAppsList
              sandboxes={sandboxes}
              activeName={activeName}
              onOpen={selectApp}
              onRemoved={onRemoved}
              onNewApp={startNewApp}
            />
          </Popover.Dropdown>
        </Popover>
      )}
      {!switcherOpen && <AppError error={appsError(sandboxes)} />}
      {unsent.map(({ id, text }) => (
        <Alert key={id} color="yellow" variant="light" className="shrink-0">
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text id={`${unsentId}-${id}`} size="sm" className="min-w-0">
              This message was not sent: “{text}”
            </Text>
            <Group wrap="nowrap" gap="xs" className="shrink-0">
              <Button
                size="compact-sm"
                variant="light"
                className="min-h-11"
                aria-describedby={`${unsentId}-${id}`}
                onClick={() => {
                  void chatRef.current?.compose(putBack(text, boxText()));
                  dismissUnsent(id);
                }}
              >
                Put it back
              </Button>
              <CloseButton
                className="min-h-11 min-w-11"
                aria-label="Dismiss"
                aria-describedby={`${unsentId}-${id}`}
                onClick={() => dismissUnsent(id)}
              />
            </Group>
          </Group>
        </Alert>
      ))}

      {session && (
        <SegmentedControl
          className="shrink-0 md:hidden"
          fullWidth
          size="md"
          classNames={{ label: 'min-h-11 flex items-center justify-center' }}
          value={shownTab}
          onChange={(value) => setTab(value as 'chat' | 'preview')}
          data={[
            { value: 'chat', label: 'Chat' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <Paper
          withBorder
          radius="md"
          data-testid="app-assistant-chat-pane"
          className={clsx(
            'min-h-0 flex-col overflow-hidden',
            session ? 'md:flex md:w-5/12 md:shrink-0' : 'w-full',
            shownTab === 'chat' ? 'flex w-full' : 'hidden'
          )}
        >
          <AppAssistantChat
            tokens={tokens}
            tools={tools}
            instructions={instructions}
            mcpServers={mcpServers}
            holdReason={active?.state === 'starting' || held ? APP_STARTING_HOLD : undefined}
            beforeToolCall={gate.beforeToolCall}
            onToolResult={gate.onToolResult}
            chatRef={chatRef}
            onBeforeSend={onSend}
            onReplyResume={onReplyResume}
            onChatChange={onChatOpened}
          />
        </Paper>
        {session && (
          <Paper
            withBorder
            radius="md"
            data-testid="app-assistant-preview-pane"
            className={clsx(
              'min-h-0 flex-1 flex-col overflow-hidden md:flex',
              shownTab === 'preview' ? 'flex' : 'hidden'
            )}
          >
            <AppAssistantPreview canPreview={canPreview} session={session} />
          </Paper>
        )}
      </div>
    </div>
  );
}
