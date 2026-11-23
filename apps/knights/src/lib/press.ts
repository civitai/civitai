// The press fields a vote body carries: written by /play at the press (`markPress`), read by the vote action, which only
// logs them. They come from the client, so reading one never fails a vote: anything unreadable is null.

export const PRESS_FIELDS = {
  pressedAt: 'pressedAt',
  waitedMs: 'waitedMs',
  signals: 'signals',
} as const;

/** The live connection at the press: open, and every stage topic the player judges confirmed by the hub. */
export type PressSignals = { connected: boolean; subscribed: boolean };

/** The decoded press fields; each is null when the body did not carry it or it is malformed or out of range. */
export type PressTiming = {
  /** Client clock at the press, ms since the epoch. */
  pressedAt: number | null;
  /** Server arrival minus `pressedAt`: mixes two clocks, so skew is in it. */
  pressGapMs: number | null;
  /** How long the vote waited in the page's serial queue, on the client's monotonic clock. */
  waitedMs: number | null;
  signalsConnected: boolean | null;
  signalsSubscribed: boolean | null;
};

const PRESSED_AT = /^\d{10,16}$/;
const WAITED_MS = /^\d{1,9}$/;
export const MAX_WAITED_MS = 24 * 60 * 60 * 1000;
const SIGNALS = /^[01]{2}$/;

/** `signals` on the wire: connected, then subscribed, each `1` or `0`. */
export const encodeSignals = ({ connected, subscribed }: PressSignals) =>
  `${connected ? 1 : 0}${subscribed ? 1 : 0}`;

function decodeSignals(value: string): PressSignals | null {
  return SIGNALS.test(value) ? { connected: value[0] === '1', subscribed: value[1] === '1' } : null;
}

export function readPress(form: FormData, arrivedAt: number): PressTiming {
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const pressedRaw = field(PRESS_FIELDS.pressedAt);
  const waitedRaw = field(PRESS_FIELDS.waitedMs);
  const pressedAt = PRESSED_AT.test(pressedRaw) ? Number(pressedRaw) : null;
  const waited = WAITED_MS.test(waitedRaw) ? Number(waitedRaw) : null;
  const signals = decodeSignals(field(PRESS_FIELDS.signals));
  return {
    pressedAt,
    pressGapMs: pressedAt === null ? null : arrivedAt - pressedAt,
    waitedMs: waited !== null && waited <= MAX_WAITED_MS ? waited : null,
    signalsConnected: signals?.connected ?? null,
    signalsSubscribed: signals?.subscribed ?? null,
  };
}
