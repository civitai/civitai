import { Menu } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { LoginRedirectReason } from '~/utils/login-helpers';

export function ReportMenuItem({
  loginReason = 'report-content',
  label = 'Report resource',
  onReport,
}: Props) {
  return (
    <LoginRedirect reason={loginReason}>
      <Menu.Item
        icon={<IconFlag size={14} stroke={1.5} />}
        onClick={(e) => {
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
