/**
 * The chat each app was last chosen in: the chat whose `create_app` made it, or whose `use_open_app`
 * chose it (`chosenAppOf`), the same choice the gate goes by. Kept per user in this browser, so opening
 * an app opens its chat with it; on another device, or once the browser forgets it, the app starts in
 * a new chat instead. A chat chooses one app at a time, so a chat that chose another app since is no
 * longer the first app's.
 */
const KEY_PREFIX = 'app-assistant:app-chats:';
/** Apps remembered per user; the oldest choice goes first. Far above the apps a user can keep. */
export const APP_CHATS_MAX = 50;

type AppChats = Record<string, string>;

const keyFor = (userId: number | null | undefined) => `${KEY_PREFIX}${userId ?? ''}`;

function read(userId: number | null | undefined): AppChats {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(keyFor(userId)) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    return {};
  }
}

/** The chat `app` was last chosen in, if this browser knows it. */
export function appChatOf(userId: number | null | undefined, app: string): string | null {
  return read(userId)[app] ?? null;
}

/** The app `chatId` last chose, if this browser knows it. */
export function appOfChat(
  userId: number | null | undefined,
  chatId: string | null | undefined
): string | null {
  if (!chatId) return null;
  return Object.entries(read(userId)).find(([, chat]) => chat === chatId)?.[0] ?? null;
}

/** `chatId` chose `app`: it is the app's chat now, and no longer any other app's. */
export function rememberAppChat(userId: number | null | undefined, app: string, chatId: string) {
  const entries = Object.entries(read(userId)).filter(
    ([known, chat]) => known !== app && chat !== chatId
  );
  entries.push([app, chatId]);
  try {
    window.localStorage.setItem(
      keyFor(userId),
      JSON.stringify(Object.fromEntries(entries.slice(-APP_CHATS_MAX)))
    );
  } catch {
    // Storage full or blocked: the app opens in a new chat next time, as on another device.
  }
}
