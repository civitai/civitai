import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createGate,
  createPrismaBridge,
  createUserSchema,
  readSettings,
  seedUser,
  type Gate,
} from './user-settings-race.harness';

/**
 * `chat.setUserSettings` — the last read-modify-write of `User.settings` left after the
 * column's writers were consolidated onto `patchUserSettings`.
 *
 * The handler read `settings.chat` out of `getUserSettings` (Redis, 4h TTL), merged the
 * request's keys onto that snapshot IN JS, and wrote the whole `chat` object back through
 * `setUserSetting`. The resulting statement is `settings || '{"chat":{…}}'::jsonb`, so the
 * top-level `chat` key is REPLACED wholesale: every sub-key reverts to whatever the
 * snapshot held, discarding any chat setting written in between.
 *
 * It is reachable in ordinary use because the three sub-keys are written from DIFFERENT
 * surfaces — `NewChat` writes `acknowledged` when the user accepts the chat terms, while
 * `ChatList` writes `muteSounds` / `replaceBadWords` from the settings menu — so two
 * requests carrying disjoint keys are the normal case, not an exotic one.
 *
 * SCOPE. Like the sibling files, this drives the REAL handler against a real Postgres and
 * suspends one statement at the wire, so what is measured is STATEMENT interleaving
 * between two logical requests. The settings cache is a pass-through here, which makes the
 * window a few milliseconds; in production the snapshot comes from a 4h-TTL Redis read, so
 * the real window is the TTL and the loss is far likelier than this timing suggests. The
 * test understates the bug rather than overstating it.
 */

const holder = {
  db: null as unknown as PGlite,
  gate: null as unknown as Gate,
  bridge: null as unknown as ReturnType<typeof createPrismaBridge>,
};

const { settingsCacheBust, metricPrivacyBust } = vi.hoisted(() => ({
  settingsCacheBust: vi.fn(async () => undefined),
  metricPrivacyBust: vi.fn(async () => undefined),
}));

// Pass-through cache: every read must reach Postgres. A caching layer here would hide the
// race behind cache timing instead of measuring the statement the handler emits.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn((opts: { lookupFn: (ids: number[]) => Promise<unknown> }) => ({
    fetch: async (ids: number | number[]) =>
      opts.lookupFn(Array.isArray(ids) ? ids : [ids]) as Promise<Record<string, unknown>>,
    bust: settingsCacheBust,
    refresh: async () => undefined,
    flush: async () => undefined,
  })),
}));

vi.mock('~/server/services/creator-membership.service', () => ({
  bustUserMetricPrivacyDefaultsCache: metricPrivacyBust,
}));

// `chat.controller` imports the chat/signal machinery at module scope, which transitively
// pulls in `image.service` and the event-engine feed modules. `setUserSettingsHandler`
// touches none of it — it only reads and writes the settings column — so the subtree is
// stubbed to keep this a test of the settings write rather than of the chat stack's
// import graph.
vi.mock('~/server/services/chat.service', () => ({
  createMessage: vi.fn(),
  upsertChat: vi.fn(),
  maxUsersPerChat: 10,
}));
vi.mock('~/server/signals/wrapper', () => ({
  withSignals: vi.fn((fn: unknown) => fn),
}));

const { setUserSettingsHandler } = await import('~/server/controllers/chat.controller');

const USER_ID = 4242;
const ctx = { user: { id: USER_ID } } as Parameters<typeof setUserSettingsHandler>[0]['ctx'];

/**
 * The settings write, in BOTH the pre-fix and post-fix statement shapes: an
 * `UPDATE "User" SET settings = …` that is not the dismissed-alerts write. Matching a
 * shape both revisions emit is deliberate — the same test then means the same thing on
 * either side of the change, rather than failing for a harness reason on one side.
 */
const isSettingsWrite = (sql: string) =>
  /UPDATE\s+"User"\s+SET\s+settings/.test(sql) && !sql.includes('jsonb_set');

/**
 * Wait for the held statement to arrive, but surface a request that FAILED or that
 * finished without ever emitting a matching statement — either would otherwise present as
 * a 60s timeout, which reads as flakiness rather than naming the real fault.
 */
async function reach(hold: { reached: Promise<void> }, inflight: Promise<unknown>) {
  await Promise.race([
    hold.reached,
    inflight.then(() => {
      throw new Error('in-flight request finished without its write reaching the gate');
    }),
  ]);
}

const chatOf = (s: Record<string, unknown>) => s.chat as Record<string, unknown> | undefined;

function installBridge() {
  const b = holder.bridge;
  for (const root of [dbMock.dbWrite, dbMock.dbRead]) {
    root.$queryRaw.mockImplementation(b.$queryRaw);
    root.$queryRawUnsafe.mockImplementation(b.$queryRawUnsafe);
    root.$executeRaw.mockImplementation(b.$executeRaw);
    root.$executeRawUnsafe.mockImplementation(b.$executeRawUnsafe);
    root.$transaction.mockImplementation(b.$transaction);
    root.user.findUnique.mockImplementation(b.user.findUnique);
    root.user.update.mockImplementation(b.user.update);
  }
}

describe('chat.setUserSettings — concurrent chat settings writes must not discard each other', () => {
  beforeAll(async () => {
    holder.db = new PGlite();
    await createUserSchema(holder.db);
  }, 60_000);

  afterAll(async () => {
    await holder.db?.close();
  });

  beforeEach(() => {
    holder.gate = createGate();
    holder.bridge = createPrismaBridge(holder.db, holder.gate);
    installBridge();
    settingsCacheBust.mockClear();
    metricPrivacyBust.mockClear();
  });

  // ---------------------------------------------------------------------------
  // REGRESSION: fails on the pre-change handler.
  // ---------------------------------------------------------------------------

  it('keeps a chat-terms acknowledgement that lands while a mute toggle is in flight', async () => {
    // Every sub-key is seeded with a value the writes CHANGE (or deliberately never
    // touch), so a merge whose operands are the wrong way round, or that replaces
    // instead of merging, produces different output. A fixture seeding a key ABSENT
    // makes "the patch wins" and "the stored column wins" byte-identical, which would
    // leave the central claim unpinned.
    await seedUser(holder.db, USER_ID, {
      dismissedAlerts: ['keep-me'],
      chat: { muteSounds: false, acknowledged: false, replaceBadWords: true },
    });

    // Request A (the ChatList mute toggle). Its read has already happened by the time the
    // statement reaches the wire, so request B below runs strictly between A's read and
    // A's write — the interleaving that loses data.
    const hold = holder.gate.hold(isSettingsWrite);
    const muteToggle = setUserSettingsHandler({ input: { muteSounds: true }, ctx });
    await reach(hold, muteToggle);

    // Request B (the NewChat terms acceptance), start to finish, in the gap.
    await setUserSettingsHandler({ input: { acknowledged: true }, ctx });

    hold.release();
    await muteToggle;

    const chat = chatOf(await readSettings(holder.db, USER_ID));
    // Pre-change: request A wrote the whole `chat` object computed from a snapshot taken
    // before B existed, so `acknowledged` reverted to false and the user was asked to
    // accept the chat terms again.
    expect(chat).toEqual({ muteSounds: true, acknowledged: true, replaceBadWords: true });
  });

  it('keeps a mute toggle that lands while a chat-terms acknowledgement is in flight', async () => {
    // The mirror ordering. Both directions lose data on the pre-change handler, and a fix
    // that merged in only one direction would pass the case above alone.
    await seedUser(holder.db, USER_ID, {
      dismissedAlerts: ['keep-me'],
      chat: { muteSounds: false, acknowledged: false, replaceBadWords: true },
    });

    const hold = holder.gate.hold(isSettingsWrite);
    const acknowledge = setUserSettingsHandler({ input: { acknowledged: true }, ctx });
    await reach(hold, acknowledge);

    await setUserSettingsHandler({ input: { muteSounds: true }, ctx });

    hold.release();
    await acknowledge;

    const chat = chatOf(await readSettings(holder.db, USER_ID));
    expect(chat).toEqual({ muteSounds: true, acknowledged: true, replaceBadWords: true });
  });

  it('returns the settings actually stored, not the ones computed from a stale snapshot', async () => {
    // The client writes this return value straight into its query cache
    // (`queryUtils.chat.getUserSettings.setData`), so a return computed from the losing
    // snapshot leaves the UI showing a value the database does not hold — the toggle
    // reads as applied and silently is not.
    await seedUser(holder.db, USER_ID, {
      chat: { muteSounds: false, acknowledged: false, replaceBadWords: true },
    });

    const hold = holder.gate.hold(isSettingsWrite);
    const muteToggle = setUserSettingsHandler({ input: { muteSounds: true }, ctx });
    await reach(hold, muteToggle);

    await setUserSettingsHandler({ input: { acknowledged: true }, ctx });

    hold.release();
    const returned = await muteToggle;

    expect(returned).toEqual({ muteSounds: true, acknowledged: true, replaceBadWords: true });
    expect(returned).toEqual(chatOf(await readSettings(holder.db, USER_ID)));
  });

  // ---------------------------------------------------------------------------
  // INVARIANT GUARDS: these hold on BOTH revisions. Labelled as such — they pin
  // behaviour the change must not break, and are NOT evidence the bug existed.
  // ---------------------------------------------------------------------------

  it('INVARIANT: writes only the keys it was given, leaving sibling chat sub-keys alone', async () => {
    await seedUser(holder.db, USER_ID, {
      chat: { muteSounds: false, acknowledged: true, replaceBadWords: true },
    });

    await setUserSettingsHandler({ input: { muteSounds: true }, ctx });

    const chat = chatOf(await readSettings(holder.db, USER_ID));
    // `replaceBadWords` is seeded TRUE and never written; a handler that replaced `chat`
    // with just the request payload would drop it entirely.
    expect(chat).toEqual({ muteSounds: true, acknowledged: true, replaceBadWords: true });
  });

  it('INVARIANT: leaves unrelated top-level settings keys untouched', async () => {
    await seedUser(holder.db, USER_ID, {
      dismissedAlerts: ['keep-me'],
      allowAds: true,
      chat: { muteSounds: false },
    });

    await setUserSettingsHandler({ input: { muteSounds: true }, ctx });

    const settings = await readSettings(holder.db, USER_ID);
    expect(settings.dismissedAlerts).toEqual(['keep-me']);
    expect(settings.allowAds).toBe(true);
  });

  it('INVARIANT: creates the chat object for a user who has no chat settings yet', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['keep-me'] });

    const returned = await setUserSettingsHandler({ input: { acknowledged: true }, ctx });

    expect(chatOf(await readSettings(holder.db, USER_ID))).toEqual({ acknowledged: true });
    expect(returned).toEqual({ acknowledged: true });
  });

  it('INVARIANT: busts the settings cache so the next read does not serve the old blob', async () => {
    // The cache is the reason the production window is 4h rather than milliseconds.
    // Without this assertion, deleting the bust leaves the suite green.
    await seedUser(holder.db, USER_ID, { chat: { muteSounds: false } });

    await setUserSettingsHandler({ input: { muteSounds: true }, ctx });

    expect(settingsCacheBust).toHaveBeenCalledWith([USER_ID]);
  });

  /**
   * 🔴 THE `features.chat` REOPEN (#4119), WHICH ARRIVED WITH NO TEST OF ITS OWN.
   *
   * `chat-dm-policy.test.ts` covers the policy RESOLVER; nothing exercised the handler's
   * second WRITE. That gap was found while resolving a merge conflict between #4119 and
   * this change — both edited this handler — so the write was being reshaped with nothing
   * watching it. These pin it.
   *
   * The reopen arrived as `setUserSetting({ features: { ...features, chat: true } })`,
   * rebuilding the whole `features` object from the same 4h-TTL Redis snapshot this
   * change exists to stop reading — the identical lost-update shape, one key over. The
   * resolution routes it through the same atomic `mergeInto`. The interleaved case below
   * is the one that distinguishes the two implementations — and it had to be interleaved:
   * the non-interleaved version of it passed against BOTH, which is documented on the
   * test itself because that is the trap, not a footnote.
   */
  describe('reopening features.chat when a DM policy is chosen', () => {
    it('sets features.chat true when the policy is not `nobody` and chat was closed', async () => {
      await seedUser(holder.db, USER_ID, { features: { chat: false } });

      await setUserSettingsHandler({ input: { dmPolicy: 'everyone' }, ctx });

      const settings = await readSettings(holder.db, USER_ID);
      expect((settings.features as Record<string, unknown>).chat).toBe(true);
      expect(chatOf(settings)).toEqual({ dmPolicy: 'everyone' });
    });

    /**
     * 🔴 THE DISCRIMINATING CASE, AND IT HAS TO BE INTERLEAVED TO BE ONE.
     *
     * The obvious version — seed a sibling, call the handler, assert it survived — does
     * NOT distinguish a merge from a whole-key replace. This suite's cache is a
     * pass-through to Postgres, so the snapshot the handler reads always already contains
     * the sibling, and `{ ...features, chat: true }` writes it straight back. Measured,
     * not assumed: that fixture passed 11/11 against the replace implementation, i.e. the
     * mutant SURVIVED. It was a fixture that could not observe the bug.
     *
     * The sibling has to appear AFTER the handler takes its snapshot. Then the replace
     * writes a `features` rebuilt from a snapshot that predates it and the sibling is
     * lost, while a merge over the stored column keeps it. That is the production shape —
     * the snapshot there is up to 4h stale, so this understates the window.
     */
    it('keeps a features sibling written while the reopen is in flight', async () => {
      await seedUser(holder.db, USER_ID, { features: { chat: false } });

      const hold = holder.gate.hold(isSettingsWrite);
      const inflight = setUserSettingsHandler({ input: { dmPolicy: 'following' }, ctx });
      await reach(hold, inflight);

      // A concurrent writer adds a features sub-key the in-flight snapshot never saw.
      await holder.db.query(
        `UPDATE "User" SET settings = jsonb_set(settings, '{features,someOtherFeature}', '"keep-me"') WHERE id = $1`,
        [USER_ID]
      );

      hold.release();
      await inflight;

      expect((await readSettings(holder.db, USER_ID)).features).toEqual({
        chat: true,
        someOtherFeature: 'keep-me',
      });
    });

    // CONTROL 1 — `nobody` must NOT reopen. Without this, an unconditional write passes
    // both cases above while defeating the whole point of choosing `nobody`.
    it('does NOT reopen chat when the chosen policy is `nobody`', async () => {
      await seedUser(holder.db, USER_ID, { features: { chat: false } });

      await setUserSettingsHandler({ input: { dmPolicy: 'nobody' }, ctx });

      expect((await readSettings(holder.db, USER_ID)).features).toEqual({ chat: false });
    });

    // CONTROL 2 — an ordinary chat write must not touch `features` at all.
    it('does not write features when the input carries no dmPolicy', async () => {
      await seedUser(holder.db, USER_ID, { features: { chat: false } });

      await setUserSettingsHandler({ input: { muteSounds: true }, ctx });

      expect((await readSettings(holder.db, USER_ID)).features).toEqual({ chat: false });
    });
  });
});
