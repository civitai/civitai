import type { Workflow, WorkflowTemplate } from '../orchestration';

/**
 * An in-memory stand-in for orchestration's consumer workflow routes, as the conversation store and
 * the chat's `ThreadStore` use them: each workflow belongs to the user whose token made it, and a
 * user's token reads and changes only that user's workflows. A token is `token-for-<userId>`.
 */
export class FakeOrchestration {
  readonly workflows: (Workflow & {
    id: string;
    owner: string;
    externalId?: string;
    tags: string[];
  })[] = [];
  readonly requests: { method: string; path: string; user: string }[] = [];
  #next = 0;

  static tokenFor(userId: string): string {
    return `token-for-${userId}`;
  }

  /** A `fetch` that answers the consumer routes against this store. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const token = /^Bearer token-for-(.+)$/.exec(
      new Headers(init?.headers).get('authorization') ?? ''
    );
    if (!token) return new Response('', { status: 401 });
    const user = token[1]!;
    const path = url.pathname.replace(/^\/+/, '');
    this.requests.push({ method, path, user });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const match = /^v2\/consumer\/workflows(?:\/([^/]+))?(?:\/tags\/([^/]+))?$/.exec(path);
    if (!match) return new Response('', { status: 404 });
    const [, id, tag] = match;
    if (!id && method === 'GET')
      return Response.json({
        items: this.query(user, {
          tags: url.searchParams.getAll('tags'),
          take: Number(url.searchParams.get('take') ?? 30),
        }).items,
      });
    if (!id && method === 'POST') return Response.json(this.submit(user, body as WorkflowTemplate));
    const workflow = this.workflows.find(
      (w) => w.id === decodeURIComponent(id!) && w.owner === user
    );
    if (!workflow) return new Response('', { status: 404 });
    if (tag && method === 'DELETE') {
      this.removeTag(user, workflow.id, decodeURIComponent(tag));
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT') {
      this.update(user, workflow.id, body as { metadata: unknown });
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };

  query(
    user: string,
    query: { tags?: string[]; take?: number }
  ): { items: Workflow[]; next: null } {
    const items = this.workflows
      .filter((w) => w.owner === user && (query.tags ?? []).every((t) => w.tags.includes(t)))
      .reverse()
      .slice(0, query.take ?? 30)
      .map((w) => structuredClone({ id: w.id, tags: w.tags, metadata: w.metadata }));
    return { items, next: null };
  }

  submit(user: string, template: WorkflowTemplate): Workflow {
    const existing = this.workflows.find(
      (w) => w.owner === user && w.externalId === template.externalId
    );
    if (existing)
      return structuredClone({ id: existing.id, tags: existing.tags, metadata: existing.metadata });
    const workflow = {
      id: `wf-${++this.#next}`,
      owner: user,
      externalId: template.externalId,
      tags: [...template.tags],
      metadata: structuredClone(template.metadata),
      steps: template.steps,
    };
    this.workflows.push(workflow);
    return structuredClone({ id: workflow.id, tags: workflow.tags, metadata: workflow.metadata });
  }

  update(user: string, id: string, patch: { metadata?: unknown }): void {
    const workflow = this.workflows.find((w) => w.id === id && w.owner === user);
    if (workflow && patch.metadata !== undefined)
      workflow.metadata = structuredClone(patch.metadata);
  }

  removeTag(user: string, id: string, tag: string): void {
    const workflow = this.workflows.find((w) => w.id === id && w.owner === user);
    if (workflow) workflow.tags = workflow.tags.filter((t) => t !== tag);
  }

  /** The chat's `ThreadStore` deps for `user`, against this same store: the browser's view. */
  browser(user: string) {
    return {
      orchestration: {
        submitWorkflow: async (template: unknown) =>
          this.submit(user, template as WorkflowTemplate),
        queryWorkflows: async (query: unknown) =>
          this.query(user, query as { tags?: string[]; take?: number }),
      },
      api: {
        updateWorkflow: async (id: string, patch: { metadata?: unknown }) =>
          this.update(user, id, patch),
        removeTag: async (id: string, tag: string) => this.removeTag(user, id, tag),
        deleteWorkflow: async () => undefined,
      },
    };
  }
}
