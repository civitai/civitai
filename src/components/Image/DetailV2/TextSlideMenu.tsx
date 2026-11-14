import { Menu } from '~/components/MantineOverlays';
import { ReportChapterMenuItem } from '~/components/Storyline/ReportChapterMenuItem';

/**
 * A text slide's ⋯ menu. A text is reported through its post's report, where moderators see the
 * post's text items, and the label says so.
 */
export function TextSlideMenu({ postId, children }: { postId: number; children: React.ReactNode }) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        <ReportChapterMenuItem postId={postId} label="Report post" />
      </Menu.Dropdown>
    </Menu>
  );
}
