import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_FEEDBACK_GENERIC_ERROR_MESSAGE,
  APP_FEEDBACK_INVALID_MESSAGE,
  APP_FEEDBACK_NOT_AVAILABLE_MESSAGE,
  APP_FEEDBACK_SENT_MESSAGE,
  APP_FEEDBACK_SIGNED_OUT_MESSAGE,
  appFeedbackEntryRequest,
  appFeedbackModalTitle,
  appFeedbackCharacterCounter,
  appFeedbackSubmitErrorMessage,
  buildAppFeedbackCreateInput,
  canSubmitAppFeedback,
  isAppFeedbackSubmitShortcut,
  resolveAppFeedbackRequest,
} from '~/components/AppBlocks/appFeedbackChrome';
import type { BlockHostSurface } from '~/components/AppBlocks/blockInitFragmentGate';
import {
  appFeedbackStatusMessage,
  isReporterNotifiedOwnerStatus,
} from '~/server/notifications/app-feedback.notifications';
import { createAppFeedbackSchema } from '~/server/schema/app-feedback.schema';
import { FEEDBACK_OWNER_STATUSES } from '~/shared/constants/feedback.constants';

describe('resolveAppFeedbackRequest — what each host sends', () => {
  it('page host (slug + app.page): targets the slug, surface page, no modelId', () => {
    expect(
      resolveAppFeedbackRequest({ slug: 'my-app', appBlockId: 'ab_9', slotId: 'app.page' })
    ).toEqual({ target: { slug: 'my-app' }, context: { surface: 'page' } });
  });

  it('page host ignores a modelId — a page has no model', () => {
    expect(
      resolveAppFeedbackRequest({ slug: 'my-app', slotId: 'app.page', modelId: 31337 })
    ).toEqual({ target: { slug: 'my-app' }, context: { surface: 'page' } });
  });

  it('model slot (appBlockId, no slug): targets the AppBlock id, surface slot, with modelId', () => {
    expect(
      resolveAppFeedbackRequest({
        appBlockId: 'ab_9',
        slotId: 'model.sidebar_top',
        modelId: 31337,
      })
    ).toEqual({ target: { appBlockId: 'ab_9' }, context: { surface: 'slot', modelId: 31337 } });
  });

  it('an omitted slotId is the model surface', () => {
    expect(resolveAppFeedbackRequest({ appBlockId: 'ab_9', modelId: 5 })).toEqual({
      target: { appBlockId: 'ab_9' },
      context: { surface: 'slot', modelId: 5 },
    });
  });

  it('drops a modelId the server schema would refuse', () => {
    for (const modelId of [0, -4, 1.5, Number.NaN]) {
      expect(
        resolveAppFeedbackRequest({ appBlockId: 'ab_9', slotId: 'model.sidebar_top', modelId })
      ).toEqual({ target: { appBlockId: 'ab_9' }, context: { surface: 'slot' } });
    }
  });

  it('no slug and no appBlockId → no request at all', () => {
    expect(resolveAppFeedbackRequest({ slotId: 'app.page' })).toBeNull();
    expect(resolveAppFeedbackRequest({ slug: '', appBlockId: '', modelId: 5 })).toBeNull();
  });
});

describe('appFeedbackEntryRequest — the client-side gates before eligibility is asked', () => {
  const request = { target: { slug: 'my-app' }, context: { surface: 'page' as const } };
  const gates = { isSignedIn: true, hasStoreAccess: true, hostSurface: 'page-run' as const };

  it('signed in with store access → the request', () => {
    expect(appFeedbackEntryRequest({ ...gates, request })).toBe(request);
  });

  it('signed out → null', () => {
    expect(appFeedbackEntryRequest({ ...gates, isSignedIn: false, request })).toBeNull();
  });

  it('no store access → null', () => {
    expect(appFeedbackEntryRequest({ ...gates, hasStoreAccess: false, request })).toBeNull();
  });

  it('no request → null', () => {
    expect(appFeedbackEntryRequest({ ...gates, request: null })).toBeNull();
  });
});

describe('appFeedbackEntryRequest — which host surfaces offer feedback', () => {
  const request = { target: { slug: 'my-app' }, context: { surface: 'page' as const } };
  const ask = (hostSurface: BlockHostSurface | undefined) =>
    appFeedbackEntryRequest({ isSignedIn: true, hasStoreAccess: true, hostSurface, request });

  it('the published-app surfaces (model slot, page run, private run) → the request', () => {
    for (const surface of ['model-slot', 'page-run', 'private-run'] as const)
      expect(ask(surface), surface).toBe(request);
  });

  // The dev tunnel runs the author's UNPUBLISHED code, but the server stamps the listing's
  // published version — and since owners and collaborators became eligible, its viewer would be.
  it('🔴 the author dev tunnel → null', () => {
    expect(ask('dev-tunnel')).toBeNull();
  });

  it('🔴 moderator review preview (a pending version) → null', () => {
    expect(ask('review-preview')).toBeNull();
  });

  it('a host that names no surface → null (fails closed)', () => {
    expect(ask(undefined)).toBeNull();
  });
});

/**
 * The SEAM: the surface table above only helps if every host that mounts the chrome tells it which
 * surface it is. `PageBlockHost` serves four surfaces (page run, private run, review, dev tunnel)
 * from one mount, so it must forward its own `surface` — a hardcoded literal there would give the
 * dev tunnel the button back with every behavioural test above still green. The mounters are
 * DISCOVERED, so a new one fails here until it is added to the ledger.
 */
describe('every chrome mount names its host surface', () => {
  const SRC = join(process.cwd(), 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
      return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [full] : [];
    });
  const mounts = walk(SRC).flatMap((file) => {
    const code = readFileSync(file, 'utf8');
    return [...code.matchAll(/<AppBlockChrome\b[\s\S]*?\/>/g)].map((m) => ({
      file: relative(SRC, file).split(sep).join('/'),
      hostSurface: /hostSurface=(\{surface\}|"[a-z-]+")/.exec(m[0])?.[1] ?? null,
    }));
  });

  it('the ledger: exactly these mounts, each forwarding the right surface', () => {
    expect(mounts).toEqual([
      { file: 'components/AppBlocks/IframeHost.tsx', hostSurface: '"model-slot"' },
      { file: 'components/AppBlocks/PageBlockHost.tsx', hostSurface: '{surface}' },
    ]);
  });
});

describe('buildAppFeedbackCreateInput — the literal mutation input', () => {
  it('slot: exactly target + trimmed message + {surface, modelId}', () => {
    const request = resolveAppFeedbackRequest({
      appBlockId: 'ab_9',
      slotId: 'model.sidebar_top',
      modelId: 31337,
    });
    const input = buildAppFeedbackCreateInput(request!, '  the export button 404s \n');
    expect(input).toStrictEqual({
      target: { appBlockId: 'ab_9' },
      message: 'the export button 404s',
      context: { surface: 'slot', modelId: 31337 },
    });
  });

  it('page: exactly target + message + {surface}', () => {
    const request = resolveAppFeedbackRequest({ slug: 'my-app', slotId: 'app.page' });
    expect(buildAppFeedbackCreateInput(request!, 'love it')).toStrictEqual({
      target: { slug: 'my-app' },
      message: 'love it',
      context: { surface: 'page' },
    });
  });

  it('carries no host diagnostics, and the server schema accepts it unchanged', () => {
    const request = resolveAppFeedbackRequest({
      appBlockId: 'ab_9',
      slotId: 'model.sidebar_top',
      modelId: 7,
    });
    const input = buildAppFeedbackCreateInput(request!, 'hello');
    expect(Object.keys(input).sort()).toEqual(['context', 'message', 'target']);
    expect(Object.keys(input.context).sort()).toEqual(['modelId', 'surface']);
    // Parsing strips undeclared keys, so equality proves nothing was there to strip.
    expect(createAppFeedbackSchema.parse(input)).toStrictEqual(input);
  });
});

describe('canSubmitAppFeedback', () => {
  it('refuses blank and whitespace-only text', () => {
    expect(canSubmitAppFeedback('')).toBe(false);
    expect(canSubmitAppFeedback('  \n\t ')).toBe(false);
  });

  it('accepts up to 2000 characters after trimming, refuses 2001', () => {
    expect(canSubmitAppFeedback('a')).toBe(true);
    expect(canSubmitAppFeedback(`  ${'a'.repeat(2000)}  `)).toBe(true);
    expect(canSubmitAppFeedback('a'.repeat(2001))).toBe(false);
  });
});

describe('modal copy', () => {
  it('title names the app, sanitized', () => {
    expect(appFeedbackModalTitle('Pixel Forge')).toBe(
      "Send private feedback to Pixel Forge's developer"
    );
    expect(appFeedbackModalTitle('Evil‮ppa')).toBe("Send private feedback to Evilppa's developer");
  });

  it('title falls back when there is no usable name', () => {
    expect(appFeedbackModalTitle(null)).toBe("Send private feedback to this app's developer");
    expect(appFeedbackModalTitle('​')).toBe("Send private feedback to this app's developer");
  });
});

describe('the character counter', () => {
  it('absent up to 1,500 characters, so a normal message shows none', () => {
    expect(appFeedbackCharacterCounter(0)).toBeNull();
    expect(appFeedbackCharacterCounter(900)).toBeNull();
    expect(appFeedbackCharacterCounter(1500)).toBeNull();
  });

  it('past 1,500: "<count> / <limit>" with thousands separators (WHOLE string)', () => {
    expect(appFeedbackCharacterCounter(1501)).toBe('1,501 / 2,000');
    expect(appFeedbackCharacterCounter(1850)).toBe('1,850 / 2,000');
    expect(appFeedbackCharacterCounter(2000)).toBe('2,000 / 2,000');
  });
});

describe('isAppFeedbackSubmitShortcut — Ctrl/⌘+Enter sends, plain Enter does not', () => {
  const key = (over: Partial<Parameters<typeof isAppFeedbackSubmitShortcut>[0]>) =>
    isAppFeedbackSubmitShortcut({ key: 'Enter', ctrlKey: false, metaKey: false, ...over });

  it('Ctrl+Enter and ⌘+Enter', () => {
    expect(key({ ctrlKey: true })).toBe(true);
    expect(key({ metaKey: true })).toBe(true);
  });

  it('plain Enter is a newline', () => {
    expect(key({})).toBe(false);
  });

  it('Ctrl with another key is not a send', () => {
    expect(key({ key: 'a', ctrlKey: true })).toBe(false);
  });

  it('an Enter that commits an IME composition is not a send', () => {
    expect(key({ ctrlKey: true, isComposing: true })).toBe(false);
    // Safari: the composition has already ended, but the keydown carries keyCode 229.
    expect(key({ ctrlKey: true, isComposing: false, keyCode: 229 })).toBe(false);
    // CONTROL: an ordinary Enter's keyCode (13) does not block the send.
    expect(key({ ctrlKey: true, isComposing: false, keyCode: 13 })).toBe(true);
  });
});

describe('the confirmation after sending', () => {
  it("promises a notification on resolved or won't fix (WHOLE string)", () => {
    expect(APP_FEEDBACK_SENT_MESSAGE).toBe(
      "Sent to the developer. You'll get a notification if they mark it resolved or won't fix."
    );
  });

  it('🔴 promises exactly the statuses the server notifies on — no more, no fewer', () => {
    // A RELATIONSHIP between the copy and `setAppFeedbackOwnerStatus`'s gate, checked in both
    // directions: a status the server starts notifying on that the sentence does not name, or one
    // the sentence names that the server stopped notifying on, fails here. Each status is looked for
    // under the label the reporter's own notification uses for it.
    const label = (status: (typeof FEEDBACK_OWNER_STATUSES)[number]) =>
      appFeedbackStatusMessage({ ownerStatus: status, appName: 'X' })?.message.match(
        /marked your feedback as (.+)\.$/
      )?.[1];
    const promised = FEEDBACK_OWNER_STATUSES.filter((status) =>
      APP_FEEDBACK_SENT_MESSAGE.includes(label(status) ?? status)
    );
    expect(promised).toEqual(FEEDBACK_OWNER_STATUSES.filter(isReporterNotifiedOwnerStatus));
    // Positive control: the comparison is not between two empty lists.
    expect(promised).toEqual(['resolved', 'wont_fix']);
  });
});

describe('appFeedbackSubmitErrorMessage — every server refusal reads as a sentence', () => {
  it('per-app cap and global rate limit: the server text', () => {
    expect(
      appFeedbackSubmitErrorMessage({
        message: 'You have sent this app a lot of feedback today — give it a little while.',
        data: { code: 'TOO_MANY_REQUESTS' },
      })
    ).toBe('You have sent this app a lot of feedback today — give it a little while.');
  });

  it('content filter: the server text, including the blocked URLs', () => {
    const message =
      'Your feedback links to a site that is not allowed: bad.example, worse.example. Remove the link and try again.';
    expect(appFeedbackSubmitErrorMessage({ message, data: { code: 'BAD_REQUEST' } })).toBe(message);
  });

  it('a zod refusal (JSON issue list) is not shown raw', () => {
    const message = JSON.stringify([{ code: 'too_big', path: ['message'], message: 'Too big' }]);
    expect(appFeedbackSubmitErrorMessage({ message, data: { code: 'BAD_REQUEST' } })).toBe(
      APP_FEEDBACK_INVALID_MESSAGE
    );
  });

  it('muted / collection off (FORBIDDEN): the server text', () => {
    expect(
      appFeedbackSubmitErrorMessage({
        message: 'Your account cannot send feedback right now',
        data: { code: 'FORBIDDEN' },
      })
    ).toBe('Your account cannot send feedback right now');
  });

  it('not eligible (NOT_FOUND): one neutral sentence, not "App not found"', () => {
    expect(
      appFeedbackSubmitErrorMessage({ message: 'App not found', data: { code: 'NOT_FOUND' } })
    ).toBe(APP_FEEDBACK_NOT_AVAILABLE_MESSAGE);
  });

  it('signed out mid-session', () => {
    expect(
      appFeedbackSubmitErrorMessage({ message: 'UNAUTHORIZED', data: { code: 'UNAUTHORIZED' } })
    ).toBe(APP_FEEDBACK_SIGNED_OUT_MESSAGE);
  });

  it('anything else, or a code with no text: the generic sentence', () => {
    expect(
      appFeedbackSubmitErrorMessage({
        message: 'connect ECONNREFUSED',
        data: { code: 'INTERNAL_SERVER_ERROR' },
      })
    ).toBe(APP_FEEDBACK_GENERIC_ERROR_MESSAGE);
    expect(appFeedbackSubmitErrorMessage({ message: '', data: { code: 'FORBIDDEN' } })).toBe(
      APP_FEEDBACK_GENERIC_ERROR_MESSAGE
    );
    expect(appFeedbackSubmitErrorMessage({ message: 'boom', data: null })).toBe(
      APP_FEEDBACK_GENERIC_ERROR_MESSAGE
    );
  });
});
