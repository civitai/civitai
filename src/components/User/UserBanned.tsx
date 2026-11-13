import { IconBan } from '@tabler/icons-react';
import { Button, Text, ThemeIcon, Title } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SiteAppealPanel } from '~/components/SiteAppeal/SiteAppealPanel';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isDefined } from '~/utils/type-guards';

export default function UserBanned() {
  const user = useCurrentUser();
  const { logout } = useAccountContext();
  const features = useFeatureFlags();

  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 overflow-y-auto p-3">
      <ThemeIcon size={128} radius={100} color="red">
        <IconBan size={80} />
      </ThemeIcon>
      <Title order={1} className="text-center">
        You have been banned
      </Title>
      <Text size="lg" align="center">
        This account has been banned and cannot access the site
      </Text>
      {user?.banDetails?.banReason && (
        <div className="flex flex-col gap-3">
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
      {/* Every page renders this screen for a banned account, so the appeal and its outcome live here. */}
      {features.siteAppealForm && (
        <div className="w-full max-w-xl">
          <SiteAppealPanel accountOnly />
        </div>
      )}
      <Button onClick={() => logout()}>Sign out</Button>
    </div>
  );
}
