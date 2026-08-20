// Crosses a JSON boundary, so `Date` arrives as `string`.

export type TopChatter = {
  userId: number;
  username: string | null;
  bannedAt: string | null;
  messages: number;
};

export type TopChat = { chatId: number; messages: number };

export type ChatStats = {
  chats: number;
  chats24h: number;
  messages: number;
  messages24h: number;
  topChatters: TopChatter[];
  topChatters24h: TopChatter[];
  chattersCapped: boolean;
  chattersCapped24h: boolean;
  topChats: TopChat[];
  topChats24h: TopChat[];
};

export type SpamGroup = {
  key: string;
  userId: number;
  username: string | null;
  bannedAt: string | null;
  content: string;
  chats: number;
};

export type NewestMessage = {
  id: number;
  chatId: number;
  userId: number;
  username: string | null;
  bannedAt: string | null;
  content: string;
  createdAt: string;
};

// Each section is null when its own query failed — one slow scan must not blank the other two.
export type ChatInsights = {
  stats: ChatStats | null;
  spam: { groups: SpamGroup[]; days: number; truncated: boolean } | null;
  newest: NewestMessage[] | null;
};

export async function fetchChatInsights(): Promise<ChatInsights> {
  const r = await fetch('/api/chat-insights');
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
