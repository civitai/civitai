import { Menu } from '@mantine/core';
import { IconDotsVertical, IconInfoCircle, IconTagOff } from '@tabler/icons-react';
import React from 'react';
import { useMenuSheet } from '~/components/Drawer/useMenuSheet';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { openBlockModelTagsModal } from '~/components/Dialog/triggers/block-model-tags';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import type { TransformedModel } from '~/shared/search/models-transform';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { isDefined } from '~/utils/type-guards';
import { useShowsSfwFace } from '~/hooks/useShowsSfwFace';
import { searchHitName } from '~/shared/utils/model-sfw-face';

export function TopRightIcons({
  setFlipped,
  data,
  imageId,
}: {
  setFlipped: React.Dispatch<React.SetStateAction<boolean>>;
  data: TransformedModel;
  imageId?: number;
}) {
  const showSfwFace = useShowsSfwFace();

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
        <ModelCardMenu
          data={data}
          imageId={imageId}
          target={
            <LegacyActionIcon variant="transparent" className="mix-blend-difference" p={0}>
              <IconDotsVertical size={24} style={{ filter: `drop-shadow(0 0 2px #000)` }} />
            </LegacyActionIcon>
          }
        />
        <CivitaiLinkManageButton
          modelId={data.id}
          modelName={searchHitName(data, showSfwFace)}
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

/** A model's hide, block and report actions; a bottom sheet in the mobile generator. */
export function ModelCardMenu({
  data,
  imageId,
  target,
}: {
  data: TransformedModel;
  imageId?: number;
  target: React.ReactElement;
}) {
  const currentUser = useCurrentUser();
  const menuSheet = useMenuSheet();

  let contextMenuItems: React.ReactNode[] = [];

  if (currentUser?.id !== data.user.id) {
    contextMenuItems = contextMenuItems
      .concat([
        <HideModelButton key="hide-model" as="menu-item" model={data} />,
        <HideUserButton key="hide-button" as="menu-item" userId={data.user.id} />,
        <BlockUserButton key="block-button" as="menu-item" userId={data.user.id} />,
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

  if (contextMenuItems.length === 0) return null;
  return (
    <Menu position="left-start" withArrow offset={-5} {...menuSheet.menuProps}>
      <Menu.Target>
        {React.cloneElement(target, {
          'aria-label': 'Model actions',
          onClick: (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
          },
        })}
      </Menu.Target>
      <Menu.Dropdown className={menuSheet.dropdownClassName}>{contextMenuItems}</Menu.Dropdown>
      {menuSheet.backdrop}
    </Menu>
  );
}
