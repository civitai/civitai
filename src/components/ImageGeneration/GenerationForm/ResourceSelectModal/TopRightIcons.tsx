import { Menu } from '@mantine/core';
import { IconDotsVertical, IconInfoCircle, IconTagOff } from '@tabler/icons-react';
import React from 'react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { openBlockModelTagsModal } from '~/components/Dialog/triggers/block-model-tags';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import { isDefined } from '~/utils/type-guards';

export function TopRightIcons({
  setFlipped,
  data,
  imageId,
}: {
  setFlipped: React.Dispatch<React.SetStateAction<boolean>>;
  data: SearchIndexDataMap['models'][number];
  imageId?: number;
}) {
  const currentUser = useCurrentUser();

  let contextMenuItems: React.ReactNode[] = [];

  if (currentUser?.id !== data.user.id) {
    contextMenuItems = contextMenuItems
      .concat([
        <HideModelButton key="hide-model" as="menu-item" modelId={data.id} />,
        <HideUserButton key="hide-button" as="menu-item" userId={data.user.id} />,
        <ReportMenuItem
          key="report-model"
          loginReason="report-model"
          onReport={() => openReportModal({ entityType: ReportEntity.Model, entityId: data.id })}
        />,
        !!imageId ? (
          <ReportMenuItem
            key="report-image"
            label="Report image"
            onReport={() =>
              openReportModal({
                entityType: ReportEntity.Image,
                entityId: imageId,
              })
            }
          />
        ) : undefined,
      ])
      .filter(isDefined);
  }
  if (currentUser)
    contextMenuItems.splice(
      2,
      0,
      <Menu.Item
        key="block-tags"
        leftSection={<IconTagOff size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          openBlockModelTagsModal({ props: { modelId: data.id } });
        }}
      >
        {`Hide content with these tags`}
      </Menu.Item>
    );

  if (currentUser?.isModerator && env.NEXT_PUBLIC_MODEL_LOOKUP_URL) {
    contextMenuItems.unshift(
      <Menu.Item
        component="a"
        key="lookup-model"
        target="_blank"
        rel="nofollow noreferrer"
        leftSection={<IconInfoCircle size={14} stroke={1.5} />}
        href={`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${data.id}`}
        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL as string}${data.id}`, '_blank');
        }}
      >
        Lookup Model
      </Menu.Item>
    );
  }

  return (
    <>
      <div className="absolute right-9 top-2 flex flex-col gap-1">
        <LegacyActionIcon
          variant="transparent"
          className="mix-blend-difference"
          size="md"
          onClick={() => setFlipped((f) => !f)}
        >
          <IconInfoCircle strokeWidth={2.5} size={24} />
        </LegacyActionIcon>
      </div>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        {contextMenuItems.length > 0 && (
          <Menu position="left-start" withArrow offset={-5}>
            <Menu.Target>
              <LegacyActionIcon
                variant="transparent"
                className="mix-blend-difference"
                p={0}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <IconDotsVertical size={24} style={{ filter: `drop-shadow(0 0 2px #000)` }} />
              </LegacyActionIcon>
            </Menu.Target>
            <Menu.Dropdown>{contextMenuItems.map((el) => el)}</Menu.Dropdown>
          </Menu>
        )}
        <CivitaiLinkManageButton
          modelId={data.id}
          modelName={data.name}
          modelType={data.type}
          hashes={data.hashes}
          noTooltip
          iconSize={16}
        >
          {({ color, onClick, icon, label }) => (
            <HoverActionButton
              onClick={onClick}
              label={label}
              size={30}
              color={color}
              variant="filled"
              keepIconOnHover
            >
              {icon}
            </HoverActionButton>
          )}
        </CivitaiLinkManageButton>
      </div>
    </>
  );
}
