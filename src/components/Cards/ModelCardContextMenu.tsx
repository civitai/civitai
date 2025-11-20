import { Menu } from '@mantine/core';
import { IconInfoCircle, IconTagOff } from '@tabler/icons-react';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openBlockModelTagsModal } from '~/components/Dialog/triggers/block-model-tags';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { ToggleSearchableMenuItem } from '~/components/MenuItems/ToggleSearchableMenuItem';
import { useModelCardContextMenu } from '~/components/Model/Actions/ModelCardContextMenu';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import { AddToShowcaseMenuItem } from '~/components/Profile/AddToShowcaseMenuItem';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { CollectionType, CosmeticEntity } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

export function ModelCardContextMenu({ data }: { data: UseQueryModelReturn[number] }) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { setMenuItems } = useModelCardContextMenu();
  const image = data.images[0];

  const reportOption = {
    key: 'report-model',
    component: (
      <ReportMenuItem
        key="report-model"
        loginReason="report-model"
        onReport={() => openReportModal({ entityType: ReportEntity.Model, entityId: data.id })}
      />
    ),
  };

  const reportImageOption = image
    ? {
        key: 'report-image',
        component: (
          <ReportMenuItem
            key="report-image"
            label="Report image"
            onReport={() =>
              openReportModal({
                entityType: ReportEntity.Image,
                entityId: image.id,
              })
            }
          />
        ),
      }
    : null;

  const blockTagsOption = {
    key: 'block-tags',
    component: (
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
    ),
  };

  let contextMenuItems: { key: string; component: React.ReactNode }[] = [];
  if (features.collections) {
    contextMenuItems.push({
      key: 'add-to-collection',
      component: (
        <AddToCollectionMenuItem
          key="add-to-collection"
          onClick={() =>
            openAddToCollectionModal({ props: { modelId: data.id, type: CollectionType.Model } })
          }
        />
      ),
    });
  }

  if (currentUser?.id === data.user.id) {
    contextMenuItems.push(
      ...[
        {
          key: 'add-to-showcase',
          component: (
            <AddToShowcaseMenuItem key="add-to-showcase" entityType="Model" entityId={data.id} />
          ),
        },
        {
          key: 'add-art-frame',
          component: (
            <AddArtFrameMenuItem
              key="add-art-frame"
              entityType={CosmeticEntity.Model}
              entityId={data.id}
              image={data.images[0]}
              currentCosmetic={data.cosmetic}
            />
          ),
        },
      ]
    );
  }

  contextMenuItems.push({
    key: 'toggle-searchable-menu-item',
    component: (
      <ToggleSearchableMenuItem
        entityType="Model"
        entityId={data.id}
        key="toggle-searchable-menu-item"
      />
    ),
  });

  if (currentUser?.id !== data.user.id)
    contextMenuItems.push(
      ...[
        {
          key: 'hide-model',
          component: <HideModelButton key="hide-model" as="menu-item" modelId={data.id} />,
        },
        {
          key: 'hide-button',
          component: <HideUserButton key="hide-button" as="menu-item" userId={data.user.id} />,
        },
        reportOption,
        reportImageOption,
      ].filter(isDefined)
    );

  if (currentUser) contextMenuItems.splice(2, 0, blockTagsOption);

  if (currentUser?.isModerator && env.NEXT_PUBLIC_MODEL_LOOKUP_URL) {
    contextMenuItems.unshift({
      key: 'lookup-model',
      component: (
        <Menu.Item
          component="a"
          key="lookup-model"
          target="_blank"
          leftSection={<IconInfoCircle size={14} stroke={1.5} />}
          href={`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${data.id}`}
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${data.id}`, '_blank');
          }}
        >
          Lookup Model
        </Menu.Item>
      ),
    });
  }

  if (setMenuItems) {
    contextMenuItems = setMenuItems(data, contextMenuItems);
  }

  return contextMenuItems.length ? (
    <Menu position="left-start" withArrow offset={-5} withinPortal>
      <Menu.Target>
        <ActionIconDotsVertical />
      </Menu.Target>
      <Menu.Dropdown>{contextMenuItems.map((el) => el.component)}</Menu.Dropdown>
    </Menu>
  ) : null;
}
