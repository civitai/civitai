import { IconBan } from '@tabler/icons-react';
import { Button, Text, ThemeIcon, Title } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { isDefined } from '~/utils/type-guards';
import styles from './UserBanned.module.scss';

export default function UserBanned() {
  const user = useCurrentUser();
  const { logout } = useAccountContext();

  return (
    <div className={styles.container}>
      <ThemeIcon size={128} radius={100} color="red">
        <IconBan size={80} className={styles.banIcon} />
      </ThemeIcon>
      <Title order={1} className={styles.title}>
        You have been banned
      </Title>
      <Text size="lg" className={styles.message}>
        This account has been banned and cannot access the site
      </Text>
      {user?.banDetails?.banReason && (
        <div className={styles.detailsContainer}>
          <DescriptionTable
            items={[
              { label: 'Reason', value: user?.banDetails?.banReason },
              user?.banDetails?.bannedReasonDetails
                ? {
                    label: 'Details',
                    value: (
                      <RenderHtml
                        html={user?.banDetails?.bannedReasonDetails}
                        style={{
                          fontSize: '14px',
                        }}
                      />
                    ),
                  }
                : undefined,
            ].filter(isDefined)}
            withBorder
          />
        </div>
      )}
      <Button className={styles.signOutButton} onClick={() => logout()}>
        Sign out
      </Button>
    </div>
  );
}

