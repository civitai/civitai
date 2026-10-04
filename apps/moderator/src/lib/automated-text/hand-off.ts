import { commentV2Url, userLookupUrl } from '$lib/entity-url';
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
};

export type HandOffLink = { label: string; href: string; external: boolean };

const isReportEntity = (v: string): v is ReportEntity =>
  (reportEntities as readonly string[]).includes(v);

/**
 * Where a labeler takes a case they judged a clear violation: the Automated report itself (its action
 * view opens one report by id whatever its status), the reported content, and the author in User
 * Lookup, which shows their CSAM reports and account actions. All of these exist already.
 */
export function handOffLinks(civitaiUrl: string, src: HandOffSource): HandOffLink[] {
  const links: HandOffLink[] = [];
  if (isReportEntity(src.entityType)) {
    links.push({
      label: 'Open the report',
      href: reportActionPath(src.entityType, src.reportId),
      external: false,
    });
    // `getReportItemUrl` has no comment-v2 case without a resolved context URL; the comment deep
    // link resolves its thread server-side instead.
    const content =
      src.entityType === 'commentV2' && src.entityId
        ? commentV2Url(civitaiUrl, src.entityId)
        : getReportItemUrl(civitaiUrl, src.entityType, src.entityId);
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
