import { Menu } from '~/components/MantineOverlays';
import { ReportChapterMenuItem } from '~/components/Storyline/ReportChapterMenuItem';

/** A text is reported through its post's report. */
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
