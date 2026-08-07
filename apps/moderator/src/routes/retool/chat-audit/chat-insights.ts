// The `/api/chat-insights` payload, declared once for the endpoint and the panel. Page-local because it
// crosses a JSON boundary — `Date` arrives as `string`.

export type TopChatter = {
  userId: number;
  username: string | null;
  bannedAt: string | null;
  messages: number;
};

export type ChatStats = {
  chats: number;
  chats24h: number;
  messages: number;
  messages24h: number;
  topChatters: TopChatter[];
  topChats: { chatId: number; messages: number }[];
};

export type SpamGroup = {
  key: string;
  userId: number;
  username: string | null;
  bannedAt: string | null;
  content: string;
  chats: number;
};

export type ChatInsights = {
  stats: ChatStats;
  spam: { groups: SpamGroup[]; days: number; truncated: boolean };
};

export async function fetchChatInsights(): Promise<ChatInsights> {
  const r = await fetch('/api/chat-insights');
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
