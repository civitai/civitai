import { openReportModal } from '~/components/Dialog/triggers/report';
import { Menu } from '~/components/MantineOverlays';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { ReportEntity } from '~/shared/utils/report-helpers';

/**
 * A text slide's ⋯ menu. A text is reported through its post's report, where moderators see the
 * post's text items, and the label says so.
 */
export function TextSlideMenu({ postId, children }: { postId: number; children: React.ReactNode }) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        <ReportMenuItem
          label="Report post"
          onReport={() => openReportModal({ entityType: ReportEntity.Post, entityId: postId })}
        />
      </Menu.Dropdown>
    </Menu>
  );
}
