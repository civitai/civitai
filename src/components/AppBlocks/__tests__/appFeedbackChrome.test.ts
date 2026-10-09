import { describe, expect, it } from 'vitest';
import {
  APP_FEEDBACK_GENERIC_ERROR_MESSAGE,
  APP_FEEDBACK_INVALID_MESSAGE,
  APP_FEEDBACK_NOT_AVAILABLE_MESSAGE,
  APP_FEEDBACK_SIGNED_OUT_MESSAGE,
  appFeedbackEntryRequest,
  appFeedbackModalTitle,
  appFeedbackSentWithLine,
  appFeedbackSubmitErrorMessage,
  buildAppFeedbackCreateInput,
  canSubmitAppFeedback,
  resolveAppFeedbackRequest,
} from '~/components/AppBlocks/appFeedbackChrome';
import { createAppFeedbackSchema } from '~/server/schema/app-feedback.schema';

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

  it('signed in with store access → the request', () => {
    expect(appFeedbackEntryRequest({ isSignedIn: true, hasStoreAccess: true, request })).toBe(
      request
    );
  });

  it('signed out → null', () => {
    expect(
      appFeedbackEntryRequest({ isSignedIn: false, hasStoreAccess: true, request })
    ).toBeNull();
  });

  it('no store access → null', () => {
    expect(
      appFeedbackEntryRequest({ isSignedIn: true, hasStoreAccess: false, request })
    ).toBeNull();
  });

  it('no request → null', () => {
    expect(
      appFeedbackEntryRequest({ isSignedIn: true, hasStoreAccess: true, request: null })
    ).toBeNull();
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

  it('sent-with line names the version when there is one', () => {
    expect(appFeedbackSentWithLine('1.4.2', { surface: 'page' })).toBe(
      'Sent with: app version 1.4.2. Nothing else is collected.'
    );
    expect(appFeedbackSentWithLine(null, { surface: 'page' })).toBe(
      'Nothing else is collected with your message.'
    );
  });

  it('sent-with line names the model whenever the request carries one', () => {
    expect(appFeedbackSentWithLine('1.4.2', { surface: 'slot', modelId: 31337 })).toBe(
      'Sent with: app version 1.4.2 and the model you were viewing. Nothing else is collected.'
    );
    expect(appFeedbackSentWithLine(null, { surface: 'slot', modelId: 31337 })).toBe(
      'Sent with: the model you were viewing. Nothing else is collected.'
    );
    expect(appFeedbackSentWithLine('1.4.2', { surface: 'slot' })).toBe(
      'Sent with: app version 1.4.2. Nothing else is collected.'
    );
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

  it('self / muted / collection off (FORBIDDEN): the server text', () => {
    expect(
      appFeedbackSubmitErrorMessage({
        message: 'You cannot send feedback to your own app',
        data: { code: 'FORBIDDEN' },
      })
    ).toBe('You cannot send feedback to your own app');
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
