import { Menu } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';

export function ReportImage({ imageId }: { imageId: number }) {
  const handleClick = () =>
    openContext('report', { entityType: ReportEntity.Image, entityId: imageId }, { zIndex: 1000 });

  return (
    <LoginRedirect reason="report-content">
      <Menu.Item icon={<IconFlag size={14} stroke={1.5} />} onClick={handleClick}>
        Report image
      </Menu.Item>
    </LoginRedirect>
  );
}
