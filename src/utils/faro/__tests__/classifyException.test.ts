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

// Edges that a green suite would otherwise leave unpinned. Each of these was found by breaking
// the implementation on purpose and noticing that nothing went red.
describe('classifyException — project-source frame edges', () => {
  // Without this, `frames.some(...)` and `isProjectSourceFrame(frames[frames.length - 1])` are
  // indistinguishable across the whole file: every other fixture puts its app frame last.
  // Shape: a third-party script invokes OUR callback, which calls fetch.
  it('KEEPS a stack whose only app frame is in the MIDDLE, not at either end', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, UPDATE_WATCHER_FRAME, OUR_FETCH_CALLER_FRAME, AD_SCRIPT_FRAME],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // Faro frames sometimes carry the position in the filename (the module's own comment cites
  // `undefined:1705:541`). If the wrapper exclusion stopped matching that spelling the gate would
  // close again and the whole fix would silently revert to inert, with every other test green.
  it.each([
    ['turbopack:///[project]/src/components/UpdateRequiredWatcher/UpdateRequiredWatcher.tsx:23:30'],
    ['turbopack:///[project]/src/components/UpdateRequiredWatcher/UpdateRequiredWatcher.tsx?rsc=1'],
  ])('excludes the global fetch wrapper when its filename carries a suffix: %s', (filename) => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', { frames: [OTEL_FETCH_FRAME, { filename }] })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // 🔴 DOCUMENTS AN ASSUMPTION THE WHOLE FIX RESTS ON. These exclusions can only work while
  // beacons carry source-resolved paths. If frames ever arrive as minified bundle URLs, our code
  // and our dependencies are indistinguishable — everything is `/_next/`, the guard says
  // "project source", and this fix drops NOTHING. That is the safe direction (no false drops),
  // but it is silent, so pin it: this test passing with `real` is the tell.
  it('an all-minified-bundle stack is KEPT as real (the fix is inert on unmapped frames)', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          { filename: 'https://civitai.com/_next/static/chunks/8154-7d2a.js', lineno: 1, colno: 9 },
          {
            filename: 'https://civitai.com/_next/static/chunks/main-app-11ab.js',
            lineno: 1,
            colno: 4,
          },
          AD_SCRIPT_FRAME,
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The abort rule shares this guard and matches its phrases as UNANCHORED substrings, so
  // narrowing what counts as project source widens that DROP too. Pinned deliberately: a stack of
  // nothing but dependency frames carrying an abort phrase is now dropped.
  it('drops an abort-phrased error whose stack is only dependency frames', () => {
    const r = classifyException(
      exc('Error', 'The operation was aborted', { frames: [OTEL_FETCH_FRAME] })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('abort');
  });
});

// 🔴 The app's dominant fetch path is tRPC, and it is the one with NO app frame of its own:
// `@trpc/client` batches and dispatches from a `setTimeout`, so the synchronous stack at
// `fetch()` is library frames only. These pin that a real API failure survives, while the
// third-party traffic this PR exists to drop still drops.
describe('classifyException — first-party API failures survive the narrowing', () => {
  const TRPC_FRAME = {
    filename:
      'turbopack:///[project]/node_modules/.pnpm/@trpc+client@11.17.0/node_modules/@trpc/client/dist/httpBatchLink.mjs',
    function: 'dispatch',
    lineno: 112,
    colno: 9,
  };
  const REACT_QUERY_FRAME = {
    filename:
      'turbopack:///[project]/node_modules/.pnpm/@tanstack+react-query@5.0.0/node_modules/@tanstack/react-query/build/modern/queryObserver.js',
    function: 'fetchOptimistic',
    lineno: 402,
    colno: 18,
  };

  it('KEEPS a failed tRPC request, whose stack carries no app frame at all', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, UPDATE_WATCHER_FRAME, TRPC_FRAME],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('KEEPS a failed react-query fetch', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, UPDATE_WATCHER_FRAME, REACT_QUERY_FRAME],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The guard above must not become a hole: an ad request that happens to sit on a page where
  // tRPC is loaded still has no tRPC frame on ITS stack, so it still drops.
  it('still drops the third-party ad fetch on a page that also uses tRPC', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, UPDATE_WATCHER_FRAME, AD_SCRIPT_FRAME],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });
});

// Round-2 review: several guards were pinned only against being NARROWED. A guard widened by
// accident is the dangerous direction here — a wider exclusion means a FALSE DROP, and a wider
// allowlist means the third-party noise comes back. These pin the other side.
describe('classifyException — guards pinned against WIDENING', () => {
  it('does NOT allowlist a neighbouring @tanstack package that is not react-query', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename:
              'turbopack:///[project]/node_modules/.pnpm/@tanstack+react-virtual@3.0.0/node_modules/@tanstack/react-virtual/dist/index.js',
            lineno: 44,
            colno: 2,
          },
        ],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // The allowlist must not be reachable from a REMOTE url. A third-party script served from a
  // path containing `/node_modules/@trpc/` is still third-party.
  it('does NOT allowlist a third-party absolute URL whose path contains the allowlist token', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename: 'https://cdn.evil.example/node_modules/@trpc/client/x.js',
            lineno: 1,
            colno: 1,
          },
        ],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // A protocol-relative third-party frame is the same traffic spelled differently.
  it('does NOT count a protocol-relative third-party script as project source', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          { filename: '//securepubads.g.doubleclick.net/gpt/pubads_impl.js', lineno: 1, colno: 1 },
        ],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // The wrapper exclusion must stay scoped to the wrapper. Its SIBLING file is ordinary app code
  // and must still prove project involvement — otherwise a widened exclusion drops real bugs.
  it('still counts the wrapper module’s sibling file as project source', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename:
              'turbopack:///[project]/src/components/UpdateRequiredWatcher/UpdateRequiredModal.tsx',
            lineno: 18,
            colno: 5,
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The generic extension test carries the same `(?:[?#:]|$)` terminator as the wrapper rule, and
  // NARROWING it here causes a false drop: a real app frame spelled as a bare source path with a
  // position would stop counting as ours.
  // Every branch of the extension alternation, not just `.ts` — otherwise dropping `jsx?` or
  // `mjs|cjs` flips a real app frame to DROPPED with a fully green suite.
  it.each([
    ['src/utils/media-upload.ts:212:9'],
    ['src/utils/media-upload.tsx:212:9'],
    ['src/utils/media-upload.js:212:9'],
    ['src/utils/media-upload.jsx:212:9'],
    ['src/utils/media-upload.mjs:212:9'],
    ['src/utils/media-upload.cjs:212:9'],
  ])('counts the bare app source path %s as project source', (filename) => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', { frames: [OTEL_FETCH_FRAME, { filename }] })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The allowlist feeds `hasProjectSourceFrame`, which the ABORT drop also consults. A cancelled
  // tRPC query (route change, unmount) is the highest-volume abort shape in this app, so pin what
  // it does rather than leaving it to be discovered.
  it('KEEPS an aborted tRPC request as real, not dropped as an abort', () => {
    const r = classifyException(
      exc('AbortError', 'The user aborted a request.', {
        frames: [
          OTEL_FETCH_FRAME,
          UPDATE_WATCHER_FRAME,
          {
            filename:
              'turbopack:///[project]/node_modules/.pnpm/@trpc+client@11.17.0/node_modules/@trpc/client/dist/httpBatchLink.mjs',
            lineno: 112,
            colno: 9,
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

// The allowlist patterns require `node_modules/@scope/` DIRECTLY, not `@scope/` anywhere under a
// dependency. Without the prefix, an unrelated package that vendors a directory named `@trpc`
// would be treated as our API client.
describe('classifyException — the client-lib allowlist requires a direct package path', () => {
  it('does NOT allowlist an @trpc directory vendored inside an unrelated dependency', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename:
              'turbopack:///[project]/node_modules/.pnpm/some-vendor@1.0.0/node_modules/some-vendor/vendor/@trpc/shim.js',
            lineno: 7,
            colno: 3,
          },
        ],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });
});

// Round-3 review: `FIRST_PARTY_ASSET_PATH_RE` became the SOLE decider for every remote frame once
// the absolute-URL branch moved first, and both of its slashes were unpinned. Dropping either one
// silently re-admits third-party traffic into `real`.
describe('classifyException — the first-party asset path needs both slashes', () => {
  it.each([
    ['https://cdn.ads.example/js/webworkers/loader.js'], // matches without the LEADING slash
    ['https://cdn.ads.example/workersfoo/x.js'], // matches without the TRAILING slash
    ['https://cdn.ads.example/my_next/bundle.js'],
    ['https://cdn.ads.example/_nextgen/bundle.js'],
  ])('does NOT count the look-alike asset path %s as project source', (filename) => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', { frames: [OTEL_FETCH_FRAME, { filename }] })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // 🔴 A DECISION ON RECORD, not an accident: the absolute branch judges the PATH and never the
  // HOST, so a foreign site's `/_next/` frame reads as ours and blocks the drop. Accepted because
  // it fails safe (keeps noise, never drops a real bug) and because the app serves from several
  // first-party domains plus per-PR preview hosts, so a static host list is what would start
  // producing false drops. If a host set is ever threaded in, this expectation is what flips.
  it('counts ANY host’s /_next/ path as project source — host is not checked, by design', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, { filename: 'https://cdn.unrelated.example/_next/static/x.js' }],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The `[/\\]` alternatives are not dead in ANY pattern: a frame can carry Windows separators.
  // Every pattern is exercised separately — the dependency rule here, the wrapper rule and BOTH
  // client-lib entries below — because losing them has a different consequence in each, and for
  // the client-lib allowlist it is a FALSE DROP.
  it('excludes a dependency frame spelled with Windows separators', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [{ filename: 'webpack://[project]\\node_modules\\some-pkg\\dist\\index.js' }],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });
});

// 🔴 These three close mutants that survived a fully green suite. The first is the one that
// matters: without the backslash alternatives in the client-lib allowlist, a Windows-spelled
// tRPC frame stops attributing the request to us and a genuine API failure is DROPPED — the one
// direction this module's header forbids.
describe('classifyException — separators and asset paths in the remaining pattern groups', () => {
  it('KEEPS a tRPC failure whose frame is spelled with Windows separators', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename:
              'webpack://[project]\\node_modules\\.pnpm\\@trpc+client@11.17.0\\node_modules\\@trpc\\client\\dist\\httpBatchLink.mjs',
            lineno: 112,
            colno: 9,
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('excludes the global fetch wrapper when its frame is spelled with Windows separators', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename:
              'webpack://[project]\\src\\components\\UpdateRequiredWatcher\\UpdateRequiredWatcher.tsx',
            lineno: 23,
            colno: 30,
          },
        ],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // The asset-path test is consulted on the NON-absolute branch too, but every other fixture
  // there also ends in a js-ish extension, so the extension test decided the outcome and this
  // clause never determined anything. A first-party asset with a non-js extension is the only
  // input it can decide.
  it('counts a relative first-party asset path with a non-js extension as project source', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, { filename: '/_next/static/css/app.css' }],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

// Round-5 review: five more mutants survived a green suite. Two flip a KEEP into a DROP — the
// direction this module's header forbids — and three re-admit noise. Most fixtures below are the
// sole observer of one of them; the abort one instead pins the behaviour the wrapper exclusion's
// scope note describes.
describe('classifyException — the last unobserved branches', () => {
  it('KEEPS a react-query failure whose frame is spelled with Windows separators', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          {
            filename:
              'webpack://[project]\\node_modules\\@tanstack\\react-query\\build\\modern\\queryObserver.js',
            lineno: 402,
            colno: 18,
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // 🔴 WIDER THAN THE FETCH PATH — rule 5 applies to every exception type. `[].every()` is `true`,
  // so an EMPTY frames array is one token away from being classified `injected` and dropped. The
  // absent-stacktrace case was pinned; this one was not, while the docstring claimed both.
  it('does NOT treat an empty frames array as an injected-extension stack', () => {
    const r = classifyException({
      type: 'TypeError',
      value: "Cannot read properties of undefined (reading 'id')",
      stacktrace: { frames: [] },
    });
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The scope note on the wrapper exclusion states that rule 1 (abort) matches UNANCHORED, so a
  // watcher error whose message merely contains an abort phrase IS droppable. That is the
  // sentence a future maintainer reads before adding a file to the list, so pin the behaviour it
  // describes rather than only asserting it in prose.
  it('drops a wrapper-framed error whose message contains an abort phrase', () => {
    const r = classifyException(
      exc('Error', 'The operation was aborted while reading update headers', {
        frames: [UPDATE_WATCHER_FRAME],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('abort');
  });

  // Safe-direction survivors (they re-admit noise rather than dropping a real bug), pinned so
  // they are not rediscovered as new findings.
  it('excludes a dependency frame whose filename STARTS with node_modules/', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [{ filename: 'node_modules/some-pkg/dist/index.js', lineno: 3, colno: 1 }],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  it('does NOT count a plain http:// third-party script as project source', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [OTEL_FETCH_FRAME, { filename: 'http://ads.example/tag.js', lineno: 1, colno: 1 }],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  it('treats a capitalised "Undefined" filename as an injected frame', () => {
    const r = classifyException(
      exc('ReferenceError', "Can't find variable: Foo", {
        frames: [{ filename: 'Undefined', lineno: 1705, colno: 541 }],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('injected');
  });
});

// Round-6 review: the bundler-scheme clause of the project-source test had NO observer at all.
// Every `turbopack://` fixture in this file also ends in a source extension, so the extension
// clause co-satisfied the guard and the scheme test never decided anything — and every
// `webpack://` fixture returned earlier via the dependency or wrapper branch, so that half had
// never executed. Deleting the clause left the suite fully green while flipping a real
// first-party frame to DROPPED. Its two siblings on the same `return` are both pinned; this is
// the third.
describe('classifyException — the bundler-scheme clause is the only thing keeping these', () => {
  it.each([
    ['turbopack:///[project]/src/styles/globals.css'],
    ['turbopack:///[project]/src/components/Feed.module.css'],
    ['turbopack:///[project]/src/data/prompts.json'],
    ['turbopack:///[project]/src/app/page'],
    ['webpack://_N_E/./src/styles/globals.css'],
  ])('counts the extensionless/non-source bundler frame %s as project source', (filename) => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', { frames: [OTEL_FETCH_FRAME, { filename }] })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

// The network and abort patterns accept an optional `TypeError: ` prefix because Faro sometimes
// carries the type only in the message. Nothing observed that prefix: every fixture built by
// `exc()` supplies a `type`, so the branch that folds the type into the message was never the
// thing that matched.
describe('classifyException — the message-only form (no `type` field)', () => {
  it.each([
    ['TypeError: Failed to fetch'],
    ['TypeError: Load failed'],
    ['TypeError: NetworkError when attempting to fetch resource.'],
  ])('drops the bare network failure %s carried entirely in the message', (value) => {
    const r = classifyException({ value });
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  it('tags a ChunkLoadError carried only in the message', () => {
    const r = classifyException({
      type: 'Error',
      value: 'ChunkLoadError: Loading chunk 12 failed.',
    });
    expect(r.drop).toBe(false);
    expect(r.category).toBe('chunkload');
  });

  it('tags a MeiliSearchCommunicationError carried only in the message', () => {
    const r = classifyException({
      type: 'Error',
      value: 'MeiliSearchCommunicationError: request failed',
    });
    expect(r.drop).toBe(false);
    expect(r.category).toBe('meili');
  });

  // `securepubads` had no sole observer: its only fixture also matched the `doubleclick` pattern.
  it('drops an ad script-load failure on a host only the securepubads pattern matches', () => {
    const r = classifyException(
      exc('UnhandledRejection', 'Failed to load script: //securepubads.example.net/tag.js')
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('adblock');
  });
});

// Round-7 review: two more code paths with no observer, both reachable, both in the direction
// this module's header forbids.
describe('classifyException — the ad-block rule needs BOTH of its conjuncts', () => {
  // Rule 2 requires a script-load SHAPE *and* an ad host. Only the host half was pinned, and
  // unlike rules 1 and 6 this rule has no project-frame guard at all — so dropping the shape
  // requirement would discard any exception whose message merely NAMES an ad host, app frame and
  // all. Those are real bugs in our own ad-integration code.
  it.each([
    ['TypeError', 'window.googletag.cmd.push is not a function'],
    ['ReferenceError', "Can't find variable: adsbygoogle"],
    ['TypeError', "Cannot read properties of undefined (reading 'doubleclick')"],
  ])('KEEPS a real app error that merely NAMES an ad host: %s / %s', (type, value) => {
    const r = classifyException(exc(type, value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

// There are TWO identical malformed-`frames` guards — one in `isInjectedOnlyStack`, one in
// `hasProjectSourceFrame`. The existing malformed-payload test reaches only the first, because
// its message matches no DROP pattern so the second guard is never called. These give the
// payload a message that DOES reach it, one per rule that consults it.
describe('classifyException — a malformed frames value reaches both guards', () => {
  const malformed = (value: string) => ({
    type: 'TypeError',
    value,
    stacktrace: { frames: {} as unknown as [] },
  });

  it('classifies a network failure with malformed frames without throwing', () => {
    let r!: ReturnType<typeof classifyException>;
    expect(() => {
      r = classifyException(malformed('Failed to fetch'));
    }).not.toThrow();
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  it('classifies an abort with malformed frames without throwing', () => {
    let r!: ReturnType<typeof classifyException>;
    expect(() => {
      r = classifyException(malformed('The user aborted a request.'));
    }).not.toThrow();
    expect(r.drop).toBe(true);
    expect(r.category).toBe('abort');
  });
});
