import { describe, it, expect } from 'vitest';
import { type ClassifiableException, classifyException } from '~/utils/faro/classifyException';

// Helper: build an exception payload. `frames` are raw stack frames (filename/lineno/colno).
const exc = (
  type: string,
  value: string,
  frames?: ClassifiableException['stacktrace']
): ClassifiableException => ({ type, value, stacktrace: frames });

// A realistic project-source frame (so an exception looks like a genuine app bug).
const APP_FRAME = {
  frames: [
    {
      filename: 'turbopack://[project]/src/components/Feed.tsx',
      function: 'render',
      lineno: 42,
      colno: 7,
    },
  ],
};

// ── Realistic production frames for a `Failed to fetch` ──────────────────────────────────────
// A browser builds a fetch-rejection stack from the SYNCHRONOUS CALL STACK at the moment
// `fetch()` is invoked, so every global wrapper between the caller and the network appears on
// EVERY fetch rejection — whoever initiated the request. These two are therefore present on
// first-party and third-party failures alike, and neither proves our code was involved.

/** The OpenTelemetry fetch instrumentation that wraps every request (a dependency). */
const OTEL_FETCH_FRAME = {
  filename:
    'turbopack:///[project]/node_modules/.pnpm/@opentelemetry+instrumentation-fetch@0.219.0_@opentelemetry+api@1.9.0/node_modules/@opentelemetry/instrumentation-fetch/src/fetch.ts',
  function: '_patchConstructor',
  lineno: 253,
  colno: 21,
};

/** Our own global `window.fetch` patch, which reads update-prompt response headers. */
const UPDATE_WATCHER_FRAME = {
  filename: 'turbopack:///[project]/src/components/UpdateRequiredWatcher/UpdateRequiredWatcher.tsx',
  function: 'window.fetch',
  lineno: 23,
  colno: 30,
};

/** The third-party ad script that actually initiated the request. */
const AD_SCRIPT_FRAME = {
  filename: 'https://securepubads.g.doubleclick.net/gpt/pubads_impl_2025092301.js',
  function: 'Bs',
  lineno: 132,
  colno: 419,
};

/** A genuine first-party caller — OUR code asking for something over the network. */
const OUR_FETCH_CALLER_FRAME = {
  filename: 'turbopack:///[project]/src/components/Generate/useGenerate.ts',
  function: 'submitGenerationRequest',
  lineno: 118,
  colno: 24,
};

describe('classifyException — DROP: request aborts', () => {
  const aborts: Array<[string, string]> = [
    ['AbortError', 'The user aborted a request.'],
    ['AbortError', 'The play() request was interrupted by a call to pause().'],
    ['AbortError', 'The fetching process for the media resource was aborted by the user agent'],
    ['AbortError', 'The operation was aborted.'],
    ['AbortError', 'signal is aborted without reason'],
  ];
  it.each(aborts)('drops AbortError: %s / %s', (type, value) => {
    const r = classifyException(exc(type, value));
    expect(r.drop).toBe(true);
    expect(r.category).toBe('abort');
  });

  it('drops nextjs route-change aborts (UnhandledRejection)', () => {
    expect(classifyException(exc('UnhandledRejection', 'nextjs route change aborted')).drop).toBe(
      true
    );
    expect(classifyException(exc('UnhandledRejection', 'routeChange aborted')).drop).toBe(true);
  });
});

describe('classifyException — DROP: ad-blocker / 3p script blocks', () => {
  const hosts = [
    'Failed to load script: //securepubads.g.doubleclick.net/tag/js/gpt.js',
    'Failed to load script: //cdn.snigelweb.com/adengine/loader.js',
    'Failed to load script: //adengine.snigelw.com/loader.js',
    'Failed to load script: googletag',
    'Failed to load script: //doubleclick.net/x',
    'Failed to load script: adsbygoogle',
  ];
  it.each(hosts)('drops ad-network script-load failure: %s', (value) => {
    const r = classifyException(exc('UnhandledRejection', value));
    expect(r.drop).toBe(true);
    expect(r.category).toBe('adblock');
  });

  it('KEEPS a "Failed to load script" for a FIRST-party bundle (genuine asset bug)', () => {
    const r = classifyException(
      exc('UnhandledRejection', 'Failed to load script: /_next/static/chunks/main-abc.js')
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

describe('classifyException — DROP: autoplay / opaque / injected / network', () => {
  it('drops autoplay NotAllowedError', () => {
    const r = classifyException(
      exc(
        'NotAllowedError',
        'The play method is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.'
      )
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('autoplay');
  });

  it('drops opaque cross-origin `Error: Script error.`', () => {
    expect(classifyException(exc('Error', 'Script error.')).drop).toBe(true);
    // Faro sometimes carries the full `Error: Script error.` as the value.
    const r = classifyException(exc('Error', 'Error: Script error.'));
    expect(r.drop).toBe(true);
    expect(r.category).toBe('script_error');
  });

  it('drops an extension-injected error whose stack has only undefined: frames', () => {
    const r = classifyException(
      exc('ReferenceError', "Can't find variable: EmptyRanges", {
        frames: [{ filename: 'undefined', lineno: 1705, colno: 541 }],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('injected');
  });

  it('drops injected error with empty-filename-only frames', () => {
    const r = classifyException(
      exc('TypeError', 'x is not defined', { frames: [{ filename: '', lineno: 1, colno: 1 }] })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('injected');
  });

  it('drops bare transient network failures with no app stack', () => {
    for (const [t, v] of [
      ['TypeError', 'Failed to fetch'],
      ['TypeError', 'NetworkError when attempting to fetch resource.'],
      ['TypeError', 'Load failed'],
    ] as const) {
      const r = classifyException(exc(t, v));
      expect(r.drop).toBe(true);
      expect(r.category).toBe('network');
    }
  });
});

describe('classifyException — TAG but keep', () => {
  it('tags expected business-logic TRPCClientError as bizlogic', () => {
    for (const v of [
      'insufficientBuzz',
      'Generation services are temporarily unavailable',
      'Prompt blocked as it may violate TOS',
      'Prompt requires mature content but workflow does not allow it',
    ]) {
      const r = classifyException(exc('TRPCClientError', v));
      expect(r.drop).toBe(false);
      expect(r.category).toBe('bizlogic');
    }
  });

  it('tags ChunkLoadError as chunkload (kept)', () => {
    const r = classifyException(exc('ChunkLoadError', 'Loading chunk 4823 failed.'));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('chunkload');
  });

  it('tags MeiliSearchCommunicationError as meili (kept)', () => {
    const r = classifyException(
      exc('MeiliSearchCommunicationError', 'request to https://search.civitai.com failed')
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('meili');
  });
});

describe('classifyException — default real (the real-app-bug stream)', () => {
  it('keeps a novel TypeError with a turbopack:// app frame as real', () => {
    const r = classifyException(
      exc('TypeError', "Cannot read properties of undefined (reading 'x')", APP_FRAME)
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('keeps an unknown error type as real', () => {
    const r = classifyException(exc('RangeError', 'Maximum call stack size exceeded', APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('handles null/undefined/empty defensively as real', () => {
    expect(classifyException(null).category).toBe('real');
    expect(classifyException(undefined).category).toBe('real');
    expect(classifyException({}).category).toBe('real');
    expect(classifyException(null).drop).toBe(false);
  });
});

// 🔴 SAFETY: no real-looking error may be dropped. These are the false-drop guards.
describe('classifyException — conservative allowlist (NEVER drop a real bug)', () => {
  it('does NOT drop a real TypeError that merely CONTAINS "Failed to fetch" in a larger message', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch model metadata: undefined is not an object', APP_FRAME)
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('does NOT drop a "Failed to fetch" that carries a real project-source app frame', () => {
    const r = classifyException(exc('TypeError', 'Failed to fetch', APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('does NOT treat a mixed stack (one injected + one app frame) as injected', () => {
    const r = classifyException(
      exc('ReferenceError', "Can't find variable: Foo", {
        frames: [
          { filename: 'undefined', lineno: 1, colno: 1 },
          { filename: 'turbopack://[project]/src/x.ts', function: 'f', lineno: 3, colno: 2 },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('does NOT drop a real error that contains the word "aborted" without an abort pattern', () => {
    const r = classifyException(
      exc('Error', 'Checkout aborted because the cart total was negative', APP_FRAME)
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('does NOT drop an error with no stack frames just for being network-shaped in a sentence', () => {
    // Anchored network patterns only match the WHOLE message; a descriptive message is kept.
    const r = classifyException(exc('Error', 'Upload failed after 3 retries'));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('does NOT drop a generic AbortError with a non-allowlisted message', () => {
    const r = classifyException(exc('AbortError', 'Custom abort we care about', APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // Audit finding: the abort DROP was the only unanchored rule with no app-frame guard, so a
  // genuine app error whose message merely CONTAINS an abort phrase (with a real app frame) was
  // being dropped. It must now be KEPT as `real`.
  it('does NOT drop a real app error that CONTAINS "The operation was aborted" but has an app frame', () => {
    const r = classifyException(
      exc('Error', 'The operation was aborted while writing user settings', {
        frames: [
          {
            filename: 'turbopack://[project]/src/store/user.ts',
            function: 'save',
            lineno: 88,
            colno: 12,
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // Audit finding: a malformed (non-array) `frames` must not throw and must not force a DROP.
  // Classification FAILS OPEN — an odd payload shape is KEPT as `real`.
  it('does NOT throw or drop on a malformed non-array stacktrace.frames', () => {
    const malformed = {
      type: 'TypeError',
      value: "Cannot read properties of undefined (reading 'id')",
      // Deliberately malformed: `frames` is an object, not an array.
      stacktrace: { frames: {} as unknown as [] },
    };
    let r!: ReturnType<typeof classifyException>;
    expect(() => {
      r = classifyException(malformed);
    }).not.toThrow();
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

// A browser builds a `Failed to fetch` stack from the synchronous call stack at the moment
// `fetch()` runs, so the fetch instrumentation and our own global `window.fetch` patch are on
// EVERY fetch rejection. Neither is evidence that our code failed; only a frame belonging to a
// genuine first-party CALLER is. These pin that distinction in both directions.
describe('classifyException — third-party network failures (fetch-wrapper frames)', () => {
  it('drops a third-party ad `Failed to fetch` carrying instrumentation + fetch-wrapper frames', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        // innermost-first, exactly as the browser reports it
        frames: [OTEL_FETCH_FRAME, UPDATE_WATCHER_FRAME, AD_SCRIPT_FRAME],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  it('does NOT count a node_modules frame as project source', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', { frames: [OTEL_FETCH_FRAME] })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  it('does NOT count the global fetch wrapper alone as project source', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', { frames: [UPDATE_WATCHER_FRAME] })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  it('does NOT count a third-party absolute .js URL as project source', () => {
    const r = classifyException(exc('TypeError', 'Failed to fetch', { frames: [AD_SCRIPT_FRAME] }));
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // 🔴 THE GUARD THAT MUST NOT REGRESS. The whole point of the project-source check is to keep
  // genuine first-party fetch bugs. The instrumentation and wrapper frames are present here too
  // (they always are) — what makes this `real` is the one frame belonging to OUR caller.
  it('KEEPS a first-party `Failed to fetch` that has a real app caller frame', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, UPDATE_WATCHER_FRAME, OUR_FETCH_CALLER_FRAME],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('KEEPS a first-party `Failed to fetch` whose app frame is a /_next/ bundle URL', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          UPDATE_WATCHER_FRAME,
          {
            filename: 'https://civitai.com/_next/static/chunks/app-layout-9f2c1d.js',
            function: 'o',
            lineno: 1,
            colno: 4821,
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('KEEPS a first-party `Failed to fetch` raised from one of our /workers/ bundles', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename: 'https://civitai.com/workers/signals.worker.js',
            function: 'connect',
            lineno: 88,
            colno: 12,
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The node_modules exclusion is scoped to the project-source guard. It must NOT make a
  // dependency frame look "injected" — that would widen the `injected` DROP to swallow genuine
  // bugs raised inside a library.
  it('does NOT treat a node_modules-only stack as an injected-extension stack', () => {
    const r = classifyException(
      exc('TypeError', "Cannot read properties of null (reading 'useState')", {
        frames: [OTEL_FETCH_FRAME],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});
