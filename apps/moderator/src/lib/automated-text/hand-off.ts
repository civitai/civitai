import { userLookupUrl } from '$lib/entity-url';
import {
  getReportItemUrl,
  reportActionPath,
  reportEntities,
  type ReportEntity,
} from '$lib/reports';

export type HandOffSource = {
  reportId: number;
  entityType: string;
  entityId: number | null;
  authorId: number | null;
  /** From `reportContextUrl`, for the types `entityUrl` cannot build a link for. */
  contextUrl?: string | null;
};

export type HandOffLink = { label: string; href: string; external: boolean };

export type ResolvedHandOff = {
  token: string;
  tag: string;
  answeredAt: Date;
  reportId: number;
  links: HandOffLink[];
  /** Links this viewer has no grant for. Named on the page with the report id, so the case still
   *  reaches someone who can act on it instead of ending at a 403. */
  blocked: string[];
  /** The report's content has been deleted, so no report page can show the report. */
  contentGone: boolean;
};

export type HandOffItem = HandOffSource & { token: string; tag: string; answeredAt: Date };

export type HandOffDeps = {
  civitaiUrl: string;
  canOpen: (path: string) => boolean;
  /** Null when the lookup failed; the links are then offered as if the content still exists. */
  lookup: (
    item: HandOffItem & { entityType: ReportEntity }
  ) => Promise<{ reachable: boolean; contextUrl: string | null } | null>;
};

const isReportEntity = (v: string): v is ReportEntity =>
  (reportEntities as readonly string[]).includes(v);

/**
 * Where a labeler takes a case they judged a clear violation: the Automated report (`?report=` opens
 * one report whatever its status), the content, and the author in User Lookup.
 */
export function handOffLinks(civitaiUrl: string, src: HandOffSource): HandOffLink[] {
  const links: HandOffLink[] = [];
  // 'unknown': no report join row, so the report page cannot show it (see reportReachability).
  if (isReportEntity(src.entityType)) {
    links.push({
      label: 'Open the report',
      href: reportActionPath(src.entityType, src.reportId),
      external: false,
    });
    const content = getReportItemUrl(civitaiUrl, src.entityType, src.entityId, src.contextUrl);
    if (content)
      links.push({
        label: 'Open the content',
        href: content,
        external: content.startsWith('http'),
      });
  }
  if (src.authorId)
    links.push({
      label: 'Author in User Lookup',
      href: userLookupUrl(src.authorId),
      external: false,
    });
  return links;
}

/** The links for each case, decided now: content deleted after the snapshot loses its report link here. */
export async function resolveHandOffs(
  items: HandOffItem[],
  deps: HandOffDeps
): Promise<ResolvedHandOff[]> {
  return Promise.all(
    items.map(async (item) => {
      const found = isReportEntity(item.entityType)
        ? await deps.lookup({ ...item, entityType: item.entityType })
        : { reachable: false, contextUrl: null };
      const contentGone = found?.reachable === false;
      const all = handOffLinks(
        deps.civitaiUrl,
        contentGone
          ? { ...item, entityType: 'unknown' }
          : { ...item, contextUrl: found?.contextUrl }
      );
      const links = all.filter((l) => l.external || deps.canOpen(l.href.split('?')[0]));
      return {
        token: item.token,
        tag: item.tag,
        answeredAt: item.answeredAt,
        reportId: item.reportId,
        links,
        blocked: all.filter((l) => !links.includes(l)).map((l) => l.label),
        contentGone,
      };
    })
  );
}
