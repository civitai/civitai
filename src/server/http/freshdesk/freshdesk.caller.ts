import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import { toBase64 } from '~/utils/string-base64-helpers';

class FreshdeskCaller extends HttpCaller {
  private static instance: FreshdeskCaller;

  protected constructor() {
    const domain = env.FRESHDESK_DOMAIN;
    const token = env.FRESHDESK_TOKEN;
    if (!domain) throw new Error('Missing FRESHDESK_DOMAIN env');
    if (!token) throw new Error('Missing FRESHDESK_TOKEN env');

    super(`${domain}/api/v2`, {
      headers: {
        Authorization: `Basic ${toBase64(`${token}:X`)}`,
        'Content-Type': 'application/json',
      },
    });
  }

  static getInstance(): FreshdeskCaller {
    if (!this.instance) {
      this.instance = new FreshdeskCaller();
    }
    return this.instance;
  }

  // --- Ticket operations ---

  async getTicket(ticketId: number) {
    return this.get<FreshdeskTicket>(`/tickets/${ticketId}`);
  }

  async getConversations(ticketId: number) {
    return this.get<FreshdeskConversation[]>(`/tickets/${ticketId}/conversations`);
  }

  async addNote(ticketId: number, body: string, isPrivate = true) {
    return this.post<FreshdeskConversation>(`/tickets/${ticketId}/notes`, {
      payload: { body, private: isPrivate },
    });
  }

  async addReply(ticketId: number, body: string) {
    return this.post<FreshdeskConversation>(`/tickets/${ticketId}/reply`, {
      payload: { body },
    });
  }

  async updateTicket(ticketId: number, data: FreshdeskTicketUpdate) {
    return this.put<FreshdeskTicket>(`/tickets/${ticketId}`, { payload: data });
  }

  async searchTickets(query: string) {
    return this.get<{ results: FreshdeskTicket[]; total: number }>(`/search/tickets`, {
      queryParams: { query: `"${query}"` },
    });
  }

  // --- Contact operations ---

  async getContact(contactId: number) {
    return this.get<FreshdeskContact>(`/contacts/${contactId}`);
  }

  async searchContacts(query: string) {
    return this.get<{ results: FreshdeskContact[]; total: number }>(`/search/contacts`, {
      queryParams: { query: `"${query}"` },
    });
  }

  // --- KB operations ---

  async searchKB(query: string) {
    return this.get<FreshdeskKBSearchResult[]>(
      `/search/solutions`,
      { queryParams: { term: query } }
    );
  }

  async getArticle(articleId: number) {
    return this.get<FreshdeskKBArticle>(`/solutions/articles/${articleId}`);
  }

  async createArticle(folderId: number, article: FreshdeskArticleCreate) {
    return this.post<FreshdeskKBArticle>(`/solutions/folders/${folderId}/articles`, {
      payload: article,
    });
  }

  async updateArticle(articleId: number, article: FreshdeskArticleUpdate) {
    return this.put<FreshdeskKBArticle>(`/solutions/articles/${articleId}`, {
      payload: article,
    });
  }

  async listCategories() {
    return this.get<FreshdeskKBCategory[]>(`/solutions/categories`);
  }

  async listFolders(categoryId: number) {
    return this.get<FreshdeskKBFolder[]>(`/solutions/categories/${categoryId}/folders`);
  }

  async listArticles(folderId: number) {
    return this.get<FreshdeskKBArticle[]>(`/solutions/folders/${folderId}/articles`);
  }
}

export const freshdeskCaller = FreshdeskCaller.getInstance();

// --- Types ---

export type FreshdeskTicket = {
  id: number;
  subject: string;
  description: string;
  description_text: string;
  status: number;
  priority: number;
  type: string | null;
  tags: string[];
  requester_id: number;
  responder_id: number | null;
  group_id: number | null;
  created_at: string;
  updated_at: string;
  custom_fields: Record<string, unknown>;
};

export type FreshdeskTicketUpdate = {
  status?: number;
  priority?: number;
  tags?: string[];
  type?: string;
  group_id?: number;
  responder_id?: number;
  custom_fields?: Record<string, unknown>;
};

export type FreshdeskConversation = {
  id: number;
  body: string;
  body_text: string;
  incoming: boolean;
  private: boolean;
  user_id: number;
  created_at: string;
  updated_at: string;
  source: number;
};

export type FreshdeskContact = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  unique_external_id: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type FreshdeskKBSearchResult = {
  id: number;
  title: string;
  description: string;
  description_text: string;
  folder_id: number;
  category_id: number;
  status: number;
};

export type FreshdeskKBArticle = {
  id: number;
  title: string;
  description: string;
  description_text: string;
  folder_id: number;
  category_id: number;
  status: number;
  tags: string[];
  created_at: string;
  updated_at: string;
};

export type FreshdeskArticleCreate = {
  title: string;
  description: string;
  status: number;
  tags?: string[];
};

export type FreshdeskArticleUpdate = {
  title?: string;
  description?: string;
  status?: number;
  tags?: string[];
};

export type FreshdeskKBCategory = {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export type FreshdeskKBFolder = {
  id: number;
  name: string;
  description: string;
  category_id: number;
  articles_count: number;
  created_at: string;
  updated_at: string;
};
