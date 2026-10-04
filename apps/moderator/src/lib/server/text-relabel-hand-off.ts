import { handOffLinks, type ResolvedHandOff } from '$lib/automated-text/hand-off';
import type { HandOffItem } from './text-relabel.service';

export type HandOffDeps = {
  civitaiUrl: string;
  canOpen: (path: string) => boolean;
  contextUrl: (item: HandOffItem) => Promise<string | null>;
};

export async function resolveHandOffs(
  items: HandOffItem[],
  deps: HandOffDeps
): Promise<ResolvedHandOff[]> {
  return Promise.all(
    items.map(async (item) => {
      const all = handOffLinks(deps.civitaiUrl, {
        ...item,
        contextUrl: await deps.contextUrl(item),
      });
      const links = all.filter((l) => l.external || deps.canOpen(l.href.split('?')[0]));
      return {
        token: item.token,
        tag: item.tag,
        answeredAt: item.answeredAt,
        reportId: item.reportId,
        links,
        blocked: all.filter((l) => !links.includes(l)).map((l) => l.label),
        contentGone: item.entityType === 'unknown',
      };
    })
  );
}
