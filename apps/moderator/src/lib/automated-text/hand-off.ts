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
  /** The reported entity is gone, so no report page can show this report. */
  contentGone: boolean;
};

const isReportEntity = (v: string): v is ReportEntity =>
  (reportEntities as readonly string[]).includes(v);

/**
 * Where a labeler takes a case they judged a clear violation: the Automated report (`?report=` opens
 * one report whatever its status), the content, and the author in User Lookup.
 */
export function handOffLinks(civitaiUrl: string, src: HandOffSource): HandOffLink[] {
  const links: HandOffLink[] = [];
  // The report page finds a report through its entity's join row, which is deleted with the entity.
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
