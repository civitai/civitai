/** The payload of `/api/csam-hold-chat/[holdId]`. */
export type HoldChatMessage = {
  id: number;
  createdAt: string;
  userId: number;
  username: string | null;
  bannedAt: string | null;
  content: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type HoldChat = {
  chatId: number;
  /** The messages the scan judged; the rest of `messages` is context around them. */
  judgedIds: number[];
  senderId: number | null;
  /** Messages between the first judged one and the first shown that the window leaves out. */
  omitted: number;
  /** False when the moderator lacks Chat Audit access: only the sender's judged messages are in `messages`. */
  fullConversation: boolean;
  messages: HoldChatMessage[];
};

const loaded = new Map<number, Promise<HoldChat>>();

/** Fetched once per hold: moving back to a hold already opened reuses its conversation. A failure is
 *  not kept, so the next try asks again. */
export function fetchHoldChat(holdId: number): Promise<HoldChat> {
  const cached = loaded.get(holdId);
  if (cached) return cached;
  const request = fetch(`/api/csam-hold-chat/${holdId}`)
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<HoldChat>;
    })
    .catch((err) => {
      loaded.delete(holdId);
      throw err;
    });
  loaded.set(holdId, request);
  return request;
}
