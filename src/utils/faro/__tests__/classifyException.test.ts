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

/**
 * A third-party script on a host that is NOT one of the enumerated ad/analytics domains. Real
 * host, measured on this stream and deliberately left off `AD_NETWORK_FRAME_HOST_RES`: it
 * appeared on 2 of the 4,000 beacons sampled across two 6h windows, below any threshold worth
 * widening a denylist for. The path is synthetic — the real one carries an opaque 32-char token,
 * which is the class `redact.ts` scrubs, so it does not belong in a fixture.
 */
const UNLISTED_THIRD_PARTY_FRAME = {
  filename: 'https://static-lib.com/s/example-bundle-id/base.min.js?v=20.9',
  function: 'n',
  lineno: 1,
  colno: 5504,
};

/**
 * A minified first-party chunk — how our bundled code is spelled in the browser. (Our own code
 * also reaches the browser as `/workers/*.worker.js`, which is why `FIRST_PARTY_ASSET_PATH_RE`
 * admits `/workers/` too.)
 */
const MINIFIED_CHUNK_FRAME = {
  filename: 'https://civitai.com/_next/static/chunks/31x1i4exiz8mm.js',
  function: 'o',
  lineno: 19,
  colno: 7373,
};
const MINIFIED_CHUNK_FRAME_2 = {
  filename: 'https://civitai.com/_next/static/chunks/1tpwgcnp2976m.js',
  function: 'r.fetch',
  lineno: 11,
  colno: 96602,
};

/**
 * The measured Chrome extension-messaging timeout, verbatim.
 *
 * 🔴 The only MESSAGE string this file extracts — every other repeated message literal is inlined
 * at its call site, and the exception is deliberate. The negatives for this pattern have to embed
 * the IDENTICAL phrase mid-message to prove what the `^` anchor buys; a hand-retyped near-copy
 * would pass whether the anchor was there or not. Deriving them from one constant makes that
 * airtight. The cost is that a wrong constant moves every derived case together, so one positive
 * below spells the phrase out in full as the control.
 */
const CHROME_CALL_METHOD = 'Window message "chrome: call method" timed out.';

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
  //
  // 🔴 The outermost frame is deliberately an UNENUMERATED third-party host, not an ad network.
  // With `AD_SCRIPT_FRAME` last this assertion could not be `drop: false` at all — rule 6b would
  // fire — so the test would be red rather than merely blind. `static-lib.com` keeps the
  // assertion reachable AND still pins `.some(...)`: under a last-frame-only mutation the middle
  // app frame stops counting, rule 6 fires, and this goes red.
  it('KEEPS a stack whose only app frame is in the MIDDLE, not at either end', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          OTEL_FETCH_FRAME,
          UPDATE_WATCHER_FRAME,
          OUR_FETCH_CALLER_FRAME,
          UNLISTED_THIRD_PARTY_FRAME,
        ],
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

  // 🔴 THE PRODUCTION SHAPE, and the one stack in this describe that a real browser can produce.
  // `beforeSend` sees the browser's own frames and the collector resolves source maps afterwards,
  // so every one of our chunks arrives as `/_next/static/chunks/<hash>.js` —
  // `hasProjectSourceFrame` answers TRUE and rule 6 cannot fire. Rule 6b decides it on the
  // OUTERMOST frame: the ad network asked for the request, so it is theirs.
  it('tags a minified-bundle stack whose OUTERMOST frame is an ad network (the production shape)', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [MINIFIED_CHUNK_FRAME, MINIFIED_CHUNK_FRAME_2, AD_SCRIPT_FRAME],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('ad_initiated');
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

// 🔴 TAG-ONLY scope. Browser extensions and page-injected scripts reference globals that only
// exist when the injection actually ran, so touching them throws in every OTHER browser —
// measured live on civitai-dp-prod (24h): `Can't find variable: __firefox__` 1,380×,
// `undefined is not an object (evaluating 'window.__firefox__.<prop>')` ~2,100×,
// `undefined is not an object (evaluating 'window.ethereum.selectedAddress = …')` ~2,300/day,
// `Can't find variable: DarkReader` 132×. Today they land in `real` and pollute the
// real-app-bug signal. They are TAGGED `extension` and KEPT — no drop, no threshold change.
//
// Two engine phrasing families name these errors, and BOTH must be matched — a one-phrasing
// matcher returned a confident zero for a whole error class. For the bare-global shapes that is
// `Can't find variable: X` vs `X is not defined`; for property access it is the
// `undefined is not an object (evaluating '…')` clause (which carries the object PATH) vs V8's
// `Cannot read properties of … (reading '…')` (which omits the base object entirely, so only a
// read of a denylisted NAME is attributable from the message).
describe('classifyException — TAG extension: browser-injected globals (kept, not dropped)', () => {
  it.each([
    ['ReferenceError', "Can't find variable: __firefox__"],
    ['ReferenceError', '__firefox__ is not defined'],
    ['ReferenceError', "Can't find variable: DarkReader"],
    ['ReferenceError', 'DarkReader is not defined'],
    ['ReferenceError', "Can't find variable: __alhWeb"],
    ['ReferenceError', '__alhWeb is not defined'],
  ])('tags the bare-global %s / %s as extension', (type, value) => {
    const r = classifyException(exc(type, value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  it.each([
    "undefined is not an object (evaluating 'window.__firefox__.reader')",
    // The shipped (post-redact) spelling: the injected property segment is ≥32 opaque chars, so
    // redact.ts's long-token pass rewrote it to `[redacted-token]` — the stable PATH prefix is
    // what the matcher may key on, never the segment after it.
    "undefined is not an object (evaluating 'window.__firefox__.[redacted-token]')",
    "undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
  ])('tags the injected-object property access %s as extension', (value) => {
    const r = classifyException(exc('TypeError', value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  it('tags a V8 property read whose READ name is a denylisted injected global', () => {
    const r = classifyException(
      exc('TypeError', "Cannot read properties of undefined (reading '__firefox__')", APP_FRAME)
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  it('tags the message-only form (type folded into the message)', () => {
    const r = classifyException({ value: "ReferenceError: Can't find variable: __firefox__" });
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  it('tags an injected-global error that carries no stack at all', () => {
    const r = classifyException(
      exc(
        'TypeError',
        "undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')"
      )
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  // INVARIANT GUARD, not a regression test (it is green on the pre-extension classifier too):
  // the tag-only change must not UN-drop anything. A denylisted global behind an all-`undefined:`
  // stack matched the `injected` DROP before this category existed and must keep matching it —
  // otherwise the stream would gain every stack-only extension error on top of the re-tag.
  it('does NOT un-drop a denylisted global whose stack is all-injected — the injected DROP still wins', () => {
    const r = classifyException(
      exc('ReferenceError', "Can't find variable: __firefox__", {
        frames: [{ filename: 'undefined', lineno: 1705, colno: 541 }],
      })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('injected');
  });
});

// Names measured live that must NOT become `extension`: unlike `__firefox__`/`DarkReader`/
// `__alhWeb` they can be app code (or third-party libraries the app embeds), so a bare-global
// error only tags when the referenced name is EXACTLY on the denylist.
describe('classifyException — extension tag: deliberate negatives (may be app code)', () => {
  it.each([
    ['ReferenceError', "Can't find variable: downProgCallback"],
    ['ReferenceError', 'syncDownloadState is not defined'],
    ['ReferenceError', "Can't find variable: jQuery"],
    ['ReferenceError', 'goog is not defined'],
    ['ReferenceError', "Can't find variable: require"],
    ['ReferenceError', 'selector is not defined'],
  ])('does NOT tag %s / %s as extension', (type, value) => {
    const r = classifyException(exc(type, value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('does NOT tag the generic V8 property-read shape with a non-denylisted name', () => {
    const r = classifyException(
      exc('TypeError', "Cannot read properties of undefined (reading 'M_ID')", APP_FRAME)
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  it('does NOT tag an app error that merely MENTIONS an injected global in prose', () => {
    const r = classifyException(
      exc('Error', 'Loader failed: window.__firefox__ handshake did not complete', APP_FRAME)
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // 🔴 What the `^` anchor on the chrome extension-messaging pattern BUYS, pinned rather than left
  // in prose: a mid-message occurrence is not evidence. Both of these would tag under an
  // unanchored substring match, and the first is the shape an app wrapper would actually produce
  // when it re-throws with its own prefix. Both embed `CHROME_CALL_METHOD` rather than a retyped
  // copy, so they cannot drift into testing a phrase the pattern never matched in the first place.
  it.each([
    ['Error', `Block bridge handshake failed: ${CHROME_CALL_METHOD}`],
    ['TypeError', `Retry exhausted — ${CHROME_CALL_METHOD}`],
  ])('does NOT tag %s / %s — the phrase is mid-message', (type, value) => {
    const r = classifyException(exc(type, value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // Plausible first-party errors that talk about window messaging without being the extension's
  // sentence. `postMessage` is live app code (the App Blocks iframe bridge), so these shapes are
  // reachable and must stay in the real-app-bug stream.
  it.each([
    ['Error', 'Window message handler threw while posting to the block iframe'],
    ['Error', 'Window message timed out waiting for the block bridge to acknowledge'],
    ['Error', 'Window message "block: call method" timed out.'],
  ])('does NOT tag the first-party window-message error %s / %s', (type, value) => {
    const r = classifyException(exc(type, value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // 🔴 The STRAIGHT DOUBLE QUOTES in the pattern are load-bearing, and the module comment says so
  // — so it is pinned here rather than left as prose. Only Chrome emits this sentence and it uses
  // `"`, so a quote-agnostic pattern would buy nothing and could reach an app message; the sibling
  // `EXTENSION_OBJECT_PATH_RES` writes `['"]` only because two ENGINES quote that clause
  // differently. Without these cases a mutant replacing each quote with `.` passes the whole suite
  // (measured: 215/215 green), because widening a KEEP+TAG never reddens a positive.
  //
  // ⚠️ If a single- or smart-quote variant is ever MEASURED on this stream, this is the test that
  // must change — and it should, together with the comment. It fails safe either way: an unmatched
  // variant stays `real`, i.e. noise kept, never a real bug hidden.
  it.each([
    ["Window message 'chrome: call method' timed out."],
    ['Window message “chrome: call method” timed out.'],
    ['Window message chrome: call method timed out.'],
  ])('does NOT tag the unmeasured quote variant %j', (value) => {
    const r = classifyException(exc('Error', value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // No-regression pin: the four existing keep-and-tag/default categories still classify
  // exactly as before the extension rule was inserted.
  it('existing categories still classify unchanged', () => {
    expect(classifyException(exc('TRPCClientError', 'insufficientBuzz')).category).toBe('bizlogic');
    expect(classifyException(exc('ChunkLoadError', 'Loading chunk 4823 failed.')).category).toBe(
      'chunkload'
    );
    expect(
      classifyException(
        exc(
          'MeiliSearchCommunicationError',
          'request to https://search.civitai.com failed',
          APP_FRAME
        )
      ).category
    ).toBe('meili');
    expect(classifyException(exc('TypeError', 'Novel app bug', APP_FRAME)).category).toBe('real');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PHRASING VARIANTS. Each rule below already matched ONE spelling of an error the browser or the
// server emits under several. Measured over 6h of dp-prod beacons (bot-filtered,
// `context_error_category="real"`): 1,017 of 7,214 real exceptions — 14.1% — were a phrasing
// variant of something the classifier was already meant to handle.
//
// 🔴 The DROP rules differ in whether they carry a SECOND conjunct, and every test group below is
// shaped by that: the abort DROP is gated on `!hasProjectSourceFrame`, so adding a phrasing to it
// changes the outcome only for beacons whose stack proves nothing; the autoplay DROP has no such
// gate, so its new phrasing is anchored to the whole message instead.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('classifyException — GROUP A: abort phrasing variants (drop is stack-gated)', () => {
  // Chromium emits a different sentence per reason a play() promise was superseded, and the help
  // URL is appended on some builds and not others. All four forms are the same benign event.
  it.each([
    [
      'AbortError',
      'The play() request was interrupted because the media was removed from the document. https://goo.gl/LdLk22',
    ],
    [
      'AbortError',
      'The play() request was interrupted because video-only background media was paused to save power. https://goo.gl/LdLk22',
    ],
    [
      'AbortError',
      'The play() request was interrupted because the media was removed from the document.',
    ],
    ['AbortError', 'Fetch is aborted'],
    ['AbortError', 'BodyStreamBuffer was aborted'],
  ])('drops the abort phrasing %s / %s when the stack proves nothing', (type, value) => {
    const r = classifyException(exc(type, value));
    expect(r.drop).toBe(true);
    expect(r.category).toBe('abort');
  });

  // 🔴 THE BOUND, PINNED. The abort rule is conjoined with `!hasProjectSourceFrame`, so these
  // phrasings do NOT drop unconditionally — a beacon carrying an app frame is still KEPT. This is
  // the test that stops the volume figures above being read as "479 beacons stop arriving".
  it.each([
    [
      'AbortError',
      'The play() request was interrupted because the media was removed from the document.',
    ],
    ['AbortError', 'Fetch is aborted'],
    ['AbortError', 'BodyStreamBuffer was aborted'],
  ])('KEEPS %s / %s when the stack carries a project-source frame', (type, value) => {
    const r = classifyException(exc(type, value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The message-only form: Faro sometimes folds the type into the value, and the two short
  // phrasings are anchored, so their optional `SomeError: ` prefix is the only thing that lets
  // them match it. Nothing else observes that prefix on these two patterns.
  it.each([['AbortError: Fetch is aborted'], ['AbortError: BodyStreamBuffer was aborted']])(
    'drops %s carried entirely in the message',
    (value) => {
      const r = classifyException({ value });
      expect(r.drop).toBe(true);
      expect(r.category).toBe('abort');
    }
  );

  // 🔴 SAFETY (invariant guards — green before this change too, kept as false-drop guards). The
  // two short phrasings are anchored BECAUSE they are short. These fixtures deliberately carry NO
  // stack at all, so the rule's `!hasProjectSourceFrame` conjunct offers no protection and the
  // anchoring is the only thing keeping them: relaxing either pattern to a substring turns all
  // three red.
  it.each([
    ['Error', 'Model fetch is aborted by the retry budget after 3 attempts'],
    [
      'Error',
      'BodyStreamBuffer was aborted while streaming the user upload, so the draft was lost',
    ],
    ['Error', 'Upload cancelled: fetch is aborted downstream'],
  ])('does NOT drop the real app error %s / %s (anchoring is the only guard)', (type, value) => {
    const r = classifyException(exc(type, value));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // Invariant guard: the enumerated reason clauses must not collapse into a bare
  // `The play() request was interrupted` prefix match, which would drop an unmeasured phrasing.
  it('does NOT drop an unenumerated play() interruption reason', () => {
    const r = classifyException(
      exc(
        'AbortError',
        'The play() request was interrupted by a smoke alarm. https://goo.gl/LdLk22'
      )
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

describe('classifyException — GROUP B: the autoplay gesture phrasing (drop is UNGATED)', () => {
  it('drops the Chromium gesture-required phrasing', () => {
    const r = classifyException(
      exc('NotAllowedError', 'play() can only be initiated by a user gesture.')
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('autoplay');
  });

  it('drops the gesture phrasing carried entirely in the message', () => {
    const r = classifyException({
      value: 'NotAllowedError: play() can only be initiated by a user gesture.',
    });
    expect(r.drop).toBe(true);
    expect(r.category).toBe('autoplay');
  });

  // 🔴 The rule consults NO stack, so an app frame does not protect this one — pinned so the
  // asymmetry with GROUP A is visible rather than inferred.
  it('drops the gesture phrasing even with a project-source app frame (rule 3 is ungated)', () => {
    const r = classifyException(
      exc('NotAllowedError', 'play() can only be initiated by a user gesture.', APP_FRAME)
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('autoplay');
  });

  // 🔴 THE DELIBERATE EXCLUSION (invariant guard — green before this change, and it must stay
  // green after). Same error TYPE, nearly the same sentence, entirely different meaning: this is a
  // user permission denial (camera / microphone / clipboard), which may be a real bug in our own
  // gating. `The play method is not allowed…` drops; `The request is not allowed…` must not.
  it.each([[APP_FRAME], [undefined]])(
    'does NOT drop the NotAllowedError PERMISSION-denial sibling (frames: %#)',
    (frames) => {
      const r = classifyException(
        exc(
          'NotAllowedError',
          'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
          frames
        )
      );
      expect(r.drop).toBe(false);
      expect(r.category).toBe('real');
    }
  );

  // Invariant guard: anchoring is what makes an ungated DROP safe. No stack here either.
  it('does NOT drop a real app error that merely QUOTES the gesture phrasing', () => {
    const r = classifyException(
      exc('Error', 'Autoplay bootstrap failed: play() can only be initiated by a user gesture.')
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

describe('classifyException — GROUP C: TAG the MetaMask extension (kept, never dropped)', () => {
  // The exception `type` arrives MINIFIED (`i`), so it carries no information and the match is on
  // the VALUE alone. This is the shape that made 206 beacons land in `real`.
  it('tags a minified-type MetaMask connect failure as extension', () => {
    const r = classifyException(exc('i', 'Failed to connect to MetaMask'));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  it('tags a MetaMask connect failure that carries an app frame', () => {
    const r = classifyException(exc('i', 'Failed to connect to MetaMask', APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  // 🔴 KEEP+TAG, never DROP. A tag is recoverable — the beacon is in Loki and queryable by
  // `context_error_category="extension"` — so if a first-party wallet connector ever ships, a
  // mis-tag can be undone from the data. A drop could not be.
  it('never drops a MetaMask error, whatever the stack shape', () => {
    for (const frames of [undefined, APP_FRAME, { frames: [OTEL_FETCH_FRAME] }]) {
      expect(classifyException(exc('i', 'Failed to connect to MetaMask', frames)).drop).toBe(false);
    }
  });

  // Anchored at the start, so a mid-message occurrence is not evidence. Documented consequence,
  // not an accident: this stays `real`.
  it('does NOT tag a message that merely mentions the MetaMask failure mid-sentence', () => {
    const r = classifyException(
      exc('TypeError', 'Wallet bridge threw: Failed to connect to MetaMask', APP_FRAME)
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
});

describe('classifyException — GROUP D: bizlogic phrasings (moderation + SFW-model block)', () => {
  // The server builds this as `Your prompt was flagged: ${blockedFor.join(', ')}`, so the suffix
  // is an open set. The pattern is anchored at the START and open at the end.
  it.each([
    ['Your prompt was flagged: breasts'],
    ['Your prompt was flagged: Inappropriate minor content'],
    // The `green`-currency variant appends a two-newline redirect hint after the reasons.
    ['Your prompt was flagged: minor\n\nTry the SFW model instead.'],
    // Matches what two live components already branch on: `startsWith('Your prompt was flagged')`,
    // with no colon required.
    ['Your prompt was flagged'],
  ])('tags the moderation phrasing %j as bizlogic', (value) => {
    const r = classifyException(exc('TRPCClientError', value));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('bizlogic');
  });

  it('tags the moderation phrasing carried entirely in the message', () => {
    const r = classifyException({ value: 'TRPCClientError: Your prompt was flagged: breasts' });
    expect(r.drop).toBe(false);
    expect(r.category).toBe('bizlogic');
  });

  // The `green`/SFW-model rewrite of `Prompt requires mature content but workflow does not allow
  // it` — same user state, different sentence. The tail is left unmatched so a reworded tail
  // cannot silently make the pattern inert.
  it.each([
    [
      'The prompt has been blocked due to mature content which is not supported by the current model',
    ],
    ['The prompt has been blocked due to mature content which this model cannot produce'],
  ])('tags the SFW-model block %j as bizlogic', (value) => {
    const r = classifyException(exc('TRPCClientError', value));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('bizlogic');
  });

  // Invariant guards: neither pattern may be reachable from the middle of an app message. The
  // moderation one is anchored; the SFW one is a distinctive full clause. Both are KEEP+TAG, so
  // the cost of a false positive is a mis-tag rather than lost data — but a mis-tag still hides a
  // real bug from the `real` stream, which is what the dashboards and alerts count.
  it.each([
    ['Error', 'Could not determine whether your prompt was flagged: the audit call timed out'],
    ['Error', 'Moderation sync failed while replaying flagged prompts'],
    ['Error', 'The prompt has been saved to drafts'],
  ])('does NOT tag %s / %s as bizlogic', (type, value) => {
    const r = classifyException(exc(type, value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // A bizlogic tag must never become a drop.
  it('keeps every new bizlogic phrasing (tag-only, no drop)', () => {
    for (const value of [
      'Your prompt was flagged: breasts',
      'The prompt has been blocked due to mature content which is not supported by the current model',
    ]) {
      expect(classifyException(exc('TRPCClientError', value)).drop).toBe(false);
    }
  });
});

// 🔴 GROUP E. Before this change, `/\(evaluating ['"]window\.ethereum/i` was the only DROP-or-TAG
// predicate in the module that was an unanchored substring with NO second conjunct, and it fires
// by design on beacons carrying app frames (rule 7 runs after every DROP). `viem` and
// `@coinbase/cdp-sdk` are live dependencies, so the day a wallet connector ships,
// `window.ethereum.*` becomes APP code and its genuine failures would be tagged out of `real`.
// Requiring `.selectedAddress` costs nothing measurable: 0 of 364 hits referenced any other
// property.
describe('classifyException — GROUP E: window.ethereum narrowed to .selectedAddress', () => {
  // No-regression pin: the shape that actually occurs still tags.
  it.each([
    ["undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')"],
    ["undefined is not an object (evaluating 'window.ethereum.selectedAddress')"],
  ])('still tags the injected read %j as extension', (value) => {
    const r = classifyException(exc('TypeError', value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  // The prefix trap named in the brief: `window.ethereumProvider` matched the OLD pattern, because
  // `window\.ethereum` is a prefix of it and nothing terminated the match.
  it('does NOT tag window.ethereumProvider — it only matched as a PREFIX', () => {
    const r = classifyException(
      exc(
        'TypeError',
        "undefined is not an object (evaluating 'window.ethereumProvider.selectedAddress')",
        APP_FRAME
      )
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // Any OTHER property on the object is now app-attributable. These are the shapes a first-party
  // wallet connector would produce.
  it.each([
    ["undefined is not an object (evaluating 'window.ethereum.request')"],
    ["undefined is not an object (evaluating 'window.ethereum.enable()')"],
    ["undefined is not an object (evaluating 'window.ethereum.on')"],
  ])('does NOT tag the non-selectedAddress access %j', (value) => {
    const r = classifyException(exc('TypeError', value, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // Invariant guard: narrowing one entry must not have touched its siblings on the same array.
  it('still tags the __firefox__ object path (sibling pattern untouched)', () => {
    const r = classifyException(
      exc(
        'TypeError',
        "undefined is not an object (evaluating 'window.__firefox__.reader')",
        APP_FRAME
      )
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });
});

// 🔴 GROUP F. The second entry on `EXTENSION_MESSAGE_RES`: an extension naming itself by its API
// rather than its brand. Measured over 96.3h (2026-10-01T18:20Z → 2026-10-05T18:40Z, non-bot),
// `Window message "chrome: call method" timed out.` was 1,727 of 76,470 `real` exceptions (2.26%;
// hourly share p50 1.33%, max 21.11%), uniformly `browser_name=Chrome`, with no stack frame on any
// sampled beacon — and the phrase appears nowhere on `origin/main`, in the tracked tree or the
// dependency tree. Its value is as a TAIL contributor: it was the dominant single contributor to
// the worst client error-breadth reading in the window, and excluding it moves that metric's max
// by 36.9% while moving its p99 by 3.5%. Thresholds and the alerting identity stay out of this
// public repo on purpose.
describe('classifyException — GROUP F: TAG the chrome extension-messaging timeout (kept, never dropped)', () => {
  // The production shape: `type` is a plain `Error` and the beacon carries no frames at all.
  //
  // 🔴 This one case spells the message out in FULL rather than using `CHROME_CALL_METHOD`, and it
  // is the control for every case that does. A constant shared by the whole group means a wrong
  // constant moves them all together and the suite stays green against a phrase production never
  // emits; this case cannot. If it and the derived cases ever disagree, the constant is wrong.
  it('tags the measured no-stack Error form as extension', () => {
    const r = classifyException(exc('Error', 'Window message "chrome: call method" timed out.'));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  // 🔴 THE MESSAGE-ONLY FORM — the whole and only reason this entry's prefix group is
  // `[A-Za-z]*Error:` where the sibling's is `[A-Za-z]+Error:`. `+` requires a letter before
  // `Error`, so it cannot match a bare `Error:`; the first case below is the one that goes red if
  // anyone "tidies" the `*` back to `+`.
  //
  // 🔴 AND THE REASON IS NOT WHAT IT LOOKS LIKE. The production shape (`type: 'Error'` + the bare
  // phrase) tags under EITHER spelling via the `value` arm, because the prefix group is optional —
  // `+` would not have lost it. Nor does `*` make the `type + ': ' + value` composite arm live:
  // that arm cannot decide the outcome for ANY pattern on this array, since an optional prefix
  // already subsumes it. Verified exhaustively over 7 types × 4 values: 0 cases where the
  // composite matches and the bare `value` does not, under `*` AND under `+`. The array where the
  // composite genuinely decides is `SCRIPT_ERROR_RE`, whose `Error:` prefix is MANDATORY.
  it.each([
    [`Error: ${CHROME_CALL_METHOD}`],
    [`TypeError: ${CHROME_CALL_METHOD}`],
    [CHROME_CALL_METHOD],
  ])('tags the message-only form %j (no separate `type` field)', (value) => {
    const r = classifyException({ value });
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  // Rule 7 reads the MESSAGE and never consults the stack, so a project-source frame does not stop
  // the tag. (That is the opposite of the abort/network DROPs, which are gated on the stack.)
  it('tags it when an app frame is present — the rule reads the message, not the stack', () => {
    const r = classifyException(exc('Error', CHROME_CALL_METHOD, APP_FRAME));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  // 🔴 THE TAIL IS LEFT OPEN (`\b`, not `$`) AND THAT IS A DECISION, SO IT IS PINNED HERE.
  // Chromium demonstrably appends build-dependent detail to its own messages — the abort rule
  // above carries `…was removed from the document` both with and without a trailing
  // `https://goo.gl/LdLk22` help URL for exactly that reason — so an end-anchored pattern is the
  // kind that goes silently inert on a Chrome release. Without this case a mutant tightening the
  // tail to `\.?$` passes the whole suite (measured: 212/212 green), because every other positive
  // happens to end exactly at the period.
  it.each([
    [`${CHROME_CALL_METHOD} https://goo.gl/LdLk22`],
    [`${CHROME_CALL_METHOD} (messageId=42)`],
    ['Window message "chrome: call method" timed out'],
  ])('tags it with trailing detail appended: %j', (value) => {
    const r = classifyException(exc('Error', value));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('extension');
  });

  // 🔴 KEEP+TAG, never DROP — a tag is recoverable (the beacon is in Loki, queryable by
  // `context_error_category="extension"`) and a mis-drop is not. Same asymmetry as GROUP C.
  //
  // INVARIANT GUARD, not a regression test: at base this message fell through to `real`, whose
  // `drop` is ALSO `false`, so this cannot distinguish "tagged" from "defaulted" — the three
  // category-asserting cases above are what do that. It is kept only to pin the KEEP/DROP
  // direction against a future edit to rule 7, and it is labelled so nobody reads it as coverage.
  //
  // 🔴 AND THE TITLE IS DELIBERATELY NARROW. "Whatever the stack shape" would be FALSE: rule 5
  // (`isInjectedOnlyStack`) runs BEFORE rule 7 and ignores the message entirely, so an
  // all-`undefined:` stack drops as `injected` no matter what the value says — pinned by the next
  // case. These three shapes are the ones rule 5 does not claim.
  it('never drops it on any stack rule 5 does not claim', () => {
    for (const frames of [undefined, APP_FRAME, { frames: [OTEL_FETCH_FRAME] }]) {
      expect(classifyException(exc('Error', CHROME_CALL_METHOD, frames)).drop).toBe(false);
    }
  });

  // INVARIANT GUARD (green pre-change): the tag-only addition must not UN-drop anything. Mirrors
  // the same assertion already made for a denylisted bare global, and records the real precedence
  // that the test above deliberately does not overclaim: the `injected` DROP wins over rule 7.
  it('does NOT un-drop it behind an all-injected stack — the injected DROP still wins', () => {
    const r = classifyException(
      exc('Error', CHROME_CALL_METHOD, { frames: [{ filename: 'undefined', lineno: 1, colno: 9 }] })
    );
    expect(r.drop).toBe(true);
    expect(r.category).toBe('injected');
  });
});

// A single sweep asserting the pre-existing categories are all still reachable and unchanged.
// Every phrasing added above went into an EXISTING rule, so the risk is a regex that swallowed a
// neighbour rather than a new category behaving oddly.
describe('classifyException — no-regression sweep across every category', () => {
  it.each([
    ['abort', true, exc('AbortError', 'The user aborted a request.')],
    [
      'adblock',
      true,
      exc(
        'UnhandledRejection',
        'Failed to load script: //securepubads.g.doubleclick.net/tag/js/gpt.js'
      ),
    ],
    [
      'autoplay',
      true,
      exc('NotAllowedError', 'The play method is not allowed by the user agent in this context'),
    ],
    ['script_error', true, exc('Error', 'Script error.')],
    [
      'injected',
      true,
      exc('ReferenceError', "Can't find variable: EmptyRanges", {
        frames: [{ filename: 'undefined', lineno: 1705, colno: 541 }],
      }),
    ],
    ['network', true, exc('TypeError', 'Failed to fetch')],
    ['extension', false, exc('ReferenceError', "Can't find variable: __firefox__", APP_FRAME)],
    ['bizlogic', false, exc('TRPCClientError', 'insufficientBuzz')],
    ['chunkload', false, exc('ChunkLoadError', 'Loading chunk 4823 failed.')],
    [
      'meili',
      false,
      exc('MeiliSearchCommunicationError', 'request to https://search.civitai.com failed'),
    ],
    [
      'real',
      false,
      exc('TypeError', "Cannot read properties of undefined (reading 'M_ID')", APP_FRAME),
    ],
  ])('%s still classifies as before (drop=%s)', (category, drop, payload) => {
    const r = classifyException(payload as ClassifiableException);
    expect(r.category).toBe(category);
    expect(r.drop).toBe(drop);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────────────────────
// RULE 6b — third-party ad/analytics REQUEST INITIATORS
//
// 🔴 WHY THESE FIXTURES LOOK DIFFERENT FROM EVERY FIXTURE ABOVE. This classifier runs on the
// frames the BROWSER produced, where each of our chunks is spelled
// `https://<our-host>/_next/static/chunks/<hash>.js`. The `turbopack:///[project]/…` and
// `webpack://…` paths used by the fixtures above are a source-map `sources` spelling, produced by
// the collector after `beforeSend` has returned — so the rule 6 conjunct those fixtures exercise
// cannot fire on a real browser stack, and rule 6b is the only rule in this file with
// production-shaped coverage.
//
// That rests on first principles, not a count: a browser does not consult source maps to build
// `error.stack`, so a browser-produced frame cannot carry a post-resolution path. The test
// `tags a minified-bundle stack whose OUTERMOST frame is an ad network` is what pins it here.
// A tally of STORED beacons cannot support it either way — storage holds the post-resolution
// spelling, so such a count reads the same whether the claim is true or false.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Build the production stack shape: minified first-party plumbing, then the initiator outermost. */
const prodStack = (initiator: { filename: string }) => ({
  frames: [MINIFIED_CHUNK_FRAME, MINIFIED_CHUNK_FRAME_2, initiator],
});

describe('classifyException — rule 6b: TAG a bare network failure an ad network initiated', () => {
  // One case per enumerated domain, each spelled with the subdomain it was MEASURED under (which
  // is why the patterns are domain-anchored rather than hostname-exact). Deleting any one pattern
  // flips exactly the matching row.
  it.each([
    ['https://securepubads.g.doubleclick.net/pagead/managed/js/gpt/m202609250101/pubads_impl.js'],
    ['https://www.googletagmanager.com/gtag/js?id=G-TESTID001'],
    ['https://cdn.snigelweb.com/prebid/11.29.0-snpbjs/prebid.js?v=20389'],
  ])('tags a `Failed to fetch` whose outermost frame is %s', (filename) => {
    const r = classifyException(exc('TypeError', 'Failed to fetch', prodStack({ filename })));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('ad_initiated');
  });

  // The `(?:^|\.)` alternation, both halves. Without the `^` an apex-only host stops matching;
  // without the alternation being an alternation, `notdoubleclick.net` starts matching.
  it('tags on the bare apex domain', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', prodStack({ filename: 'https://doubleclick.net/gpt.js' }))
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('ad_initiated');
  });
  it('does NOT drop a host that merely ENDS with the domain text', () => {
    const r = classifyException(
      exc(
        'TypeError',
        'Failed to fetch',
        prodStack({ filename: 'https://notdoubleclick.net/gpt.js' })
      )
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The `$` anchor. A host that only CONTAINS an enumerated domain as a left-hand label is a
  // different site.
  it.each([
    ['https://doubleclick.net.example.com/x.js'],
    ['https://googletagmanager.com.cdn.example/x.js'],
  ])('does NOT drop a look-alike host: %s', (filename) => {
    const r = classifyException(exc('TypeError', 'Failed to fetch', prodStack({ filename })));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // 🔴 The host is PARSED out of the authority, never substring-matched against the filename —
  // and these fixtures have to be built carefully to observe that. A first-party URL merely
  // CONTAINING an ad domain is not enough: `…/chunks/doubleclick-shim.js` has no `.net` at all,
  // and `…?provider=googletagmanager.com` fails the `(?:^|\.)` because the preceding character is
  // `=`. The observing shape needs the domain terminal AND dot-prefixed inside the path or query.
  // The pathless row additionally observes the `?` in the authority char class: without it the
  // authority runs on into the query string and the whole thing reads as an ad host.
  it.each([
    ['https://civitai.com/_next/static/chunks/a.js?ref=.doubleclick.net'],
    ['https://civitai.com?ref=x.doubleclick.net'],
    ['https://civitai.com/_next/static/chunks/doubleclick-shim.js'],
  ])('does NOT drop a FIRST-PARTY url that merely contains an ad host: %s', (filename) => {
    const r = classifyException(exc('TypeError', 'Failed to fetch', prodStack({ filename })));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The authority parse: userinfo, port, the FQDN root label, and case are all normalised before
  // the host is tested. Each row is the sole observer of one of those.
  //
  // 🔴 The userinfo row puts the credentials IMMEDIATELY before the matched domain on purpose.
  // Spelled `user:pw@securepubads.g.doubleclick.net` the character before `doubleclick` is still
  // a `.`, so the pattern matches with or without the strip and the fixture observes nothing — it
  // survived exactly that mutant. Spelled `…@doubleclick.net` the preceding character is `@`, the
  // `(?:^|\.)` fails, and the strip is the only reason this is attributed to the ad network.
  it.each([
    ['https://user:pw@doubleclick.net/gpt/pubads_impl.js'],
    ['https://securepubads.g.doubleclick.net:443/gpt/pubads_impl.js'],
    ['https://doubleclick.net./gpt.js'],
    ['//securepubads.g.doubleclick.net/gpt/pubads_impl.js'],
    ['HTTPS://WWW.GOOGLETAGMANAGER.COM/gtag/js?id=G-TESTID002'],
    ['  https://securepubads.g.doubleclick.net/gpt/pubads_impl.js  '],
  ])(
    'tags regardless of userinfo / port / root label / scheme / case / padding: %s',
    (filename) => {
      const r = classifyException(exc('TypeError', 'Failed to fetch', prodStack({ filename })));
      expect(r.drop).toBe(false);
      expect(r.category).toBe('ad_initiated');
    }
  );

  // `lastIndexOf('@')`, not `indexOf`. With two `@` the first-index variant leaves
  // `b@doubleclick.net`, whose `@` defeats the `(?:^|\.)` — so this row flips to KEEP under that
  // mutant and is its only observer.
  it('tags when the authority carries more than one @', () => {
    const r = classifyException(
      exc(
        'TypeError',
        'Failed to fetch',
        prodStack({ filename: 'https://a@b@doubleclick.net/x.js' })
      )
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('ad_initiated');
  });
});

describe('classifyException — rule 6b: deliberate negatives (a false tag hides a real bug)', () => {
  // 🔴 THE SAFETY TEST THIS RULE EXISTS AROUND. Browser extensions demonstrably patch
  // `window.fetch` — over one measured 6h window, 1,175 of that window's 1,727 sampled
  // `TypeError: Failed to fetch` beacons carried a `chrome-extension://…` frame, our own requests
  // included. If an ad script ever does the same, its frame joins every fetch rejection as one
  // more unconditional layer, and an "ad-host frame anywhere on the stack" rule would re-tag the
  // WHOLE bare-network stream out of `real`, genuine first-party bugs included. Requiring the ad frame to be
  // OUTERMOST is what makes that impossible: replace `frames[length - 1]` with a `.some(...)` and
  // only this test fails.
  it('KEEPS our own fetch failure when an ad script merely WRAPPED fetch (frame not outermost)', () => {
    const r = classifyException(
      exc('TypeError', 'Failed to fetch', {
        frames: [
          AD_SCRIPT_FRAME,
          MINIFIED_CHUNK_FRAME,
          MINIFIED_CHUNK_FRAME_2,
          {
            filename: 'https://civitai.com/_next/static/chunks/upload-4f2a.js',
            function: 'uploadSourceImage',
          },
        ],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The message conjunct, in both directions. A real app bug whose message merely NAMES an ad
  // network, or carries the network phrase inside a larger sentence, is kept even though its
  // stack is identical to the re-tagged population's.
  it.each([
    ['TypeError', "Cannot read properties of undefined (reading 'googletag')"],
    ['TypeError', 'Failed to fetch the ad slot configuration'],
    ['TypeError', 'Ad refresh failed: Failed to fetch'],
  ])('KEEPS a non-anchored message with an ad initiator: %s / %s', (type, value) => {
    const r = classifyException(exc(type, value, prodStack(AD_SCRIPT_FRAME)));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // 🔴 The authority parse accepts ONLY `http(s)` and protocol-relative frames, and both halves
  // of that are safety properties with their own observer here. An extension-scheme frame is not
  // initiator evidence (extensions wrap fetch — see the safety test above), and `blob:` is a real
  // frame spelling for worker code whose host is merely the origin that CREATED the blob. Each
  // row carries an ad domain as its host, so it flips to `ad_initiated` the moment the scheme
  // or the `^` anchor is relaxed — varying the scheme against a matching host, rather than the
  // host against a fixed scheme, is what makes them observe anything.
  it.each([
    ['chrome-extension://doubleclick.net/injectScriptAdjust.js'],
    ['moz-extension://googletagmanager.com/content.js'],
    ['blob:https://securepubads.g.doubleclick.net/9f2c-1d'],
  ])('does NOT drop on an ad-domain host behind a non-http(s) scheme: %s', (filename) => {
    const r = classifyException(exc('TypeError', 'Failed to fetch', prodStack({ filename })));
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // `frameHost` returns null for a frame that is not an absolute URL, or that has no authority at
  // all. These are the spellings that actually occur on this stream.
  it.each([
    ['turbopack:///[project]/src/components/TrackView/TrackPageView.tsx'],
    ['<anonymous>'],
    ['//'],
  ])('does NOT drop on a frame with no parseable host: %s', (filename) => {
    const r = classifyException(exc('TypeError', 'Failed to fetch', prodStack({ filename })));
    expect(r.drop).toBe(false);
  });

  // Fails OPEN on an unreadable outermost frame: no filename to parse means no host, so no drop.
  //
  // 🔴 Of the malformed-frame shapes, only these two reach rule 6b — getting that wrong is how a
  // test reads as coverage while providing none. Both start with a `/_next/` frame, so
  // `hasProjectSourceFrame` answers TRUE, rule 6 declines, and 6b is genuinely the rule under
  // test. An EMPTY or NON-ARRAY `frames` cannot get here at all: `hasProjectSourceFrame` returns
  // `false` from its own malformed guard, so rule 6 drops the beacon as `network` first — which
  // is asserted separately below, and is why 6b's own `Array.isArray` guard has no behavioural
  // observer (its docstring says so).
  it.each<[string, unknown]>([
    ['a frame with no filename', { frames: [MINIFIED_CHUNK_FRAME, {}] }],
    ['an undefined trailing frame', { frames: [MINIFIED_CHUNK_FRAME, undefined] }],
  ])('does not throw, and keeps as real, on %s', (_name, stacktrace) => {
    const r = classifyException({
      type: 'TypeError',
      value: 'Failed to fetch',
      stacktrace,
    } as ClassifiableException);
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });

  // The ordering fact the note above rests on. This does NOT observe 6b's malformed guard — no
  // single-point change to `isAdNetworkInitiatedRequest` can move these, because rule 6 decides
  // them first. It pins that rule 6 is what decides them, which is the premise.
  it.each<[string, unknown]>([
    ['empty frames array', { frames: [] }],
    ['malformed non-array frames', { frames: 'not-an-array' }],
    [
      'an array-LIKE object indexable to an ad host',
      { frames: { length: 1, 0: { filename: 'https://securepubads.g.doubleclick.net/gpt.js' } } },
    ],
  ])('rule 6 — not 6b — decides a bare-network message with %s', (_name, stacktrace) => {
    const r = classifyException({
      type: 'TypeError',
      value: 'Failed to fetch',
      stacktrace,
    } as ClassifiableException);
    expect(r.drop).toBe(true);
    expect(r.category).toBe('network');
  });

  // 🔴 The TRPC differential, pinned because the mechanism inverts on inspection.
  // `BARE_NETWORK_VALUE_RES` permits only a `TypeError:` prefix, so the `type + ': ' + value`
  // composite does NOT match for a `TRPCClientError` — but the bare `value` DOES, so these
  // beacons are fully eligible for rules 6 and 6b and survive on the frame conjunct alone.
  // MEASURED over three adjacent 6h windows on 2026-09-30: 448–460 per window, every sampled one
  // a two-frame stack of our own minified chunks with no foreign frame at any position.
  it('KEEPS a TRPCClientError `Failed to fetch` whose stack is two of our own chunks', () => {
    const r = classifyException(
      exc('TRPCClientError', 'Failed to fetch', {
        frames: [MINIFIED_CHUNK_FRAME_2, MINIFIED_CHUNK_FRAME],
      })
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('real');
  });
  it('tags a TRPCClientError `Failed to fetch` that an ad network initiated', () => {
    const r = classifyException(
      exc('TRPCClientError', 'Failed to fetch', prodStack(AD_SCRIPT_FRAME))
    );
    expect(r.drop).toBe(false);
    expect(r.category).toBe('ad_initiated');
  });
});
