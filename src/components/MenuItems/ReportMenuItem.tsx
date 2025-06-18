import { Menu } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import type { LoginRedirectReason } from '~/utils/login-helpers';

export function ReportMenuItem({
  loginReason = 'report-content',
  label = 'Report resource',
  onReport,
}: Props) {
  return (
    <LoginRedirect reason={loginReason}>
      <Menu.Item
        leftSection={<IconFlag size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onReport();
        }}
      >
        {label}
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = {
  onReport: VoidFunction;
  label?: string;
  loginReason?: LoginRedirectReason;
};
