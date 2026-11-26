import { openReportModal } from '~/components/Dialog/triggers/report';
import { Menu } from '~/components/MantineOverlays';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { ReportChapterMenuItem } from '~/components/Storyline/ReportChapterMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';

/**
 * A text slide reports the text itself, or its post. The slide is only shown to a viewer who may
 * read the text, and its author is not offered its report (nor while the author is unknown).
 * `authorId` is the post's owner: a text is written by its post's author (`PostText.userId` is set
 * from it), and `createReport` refuses either.
 */
export function TextSlideMenu({
  postId,
  textId,
  authorId,
  children,
}: {
  postId: number;
  textId: number;
  authorId: number | undefined;
  children: React.ReactNode;
}) {
  const currentUser = useCurrentUser();
  const canReportText = !currentUser || (authorId != null && authorId !== currentUser.id);
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {canReportText && (
          <ReportMenuItem
            label="Report text"
            onReport={() =>
              openReportModal({ entityType: ReportEntity.PostText, entityId: textId })
            }
          />
        )}
        <ReportChapterMenuItem postId={postId} label="Report post" />
      </Menu.Dropdown>
    </Menu>
  );
}
