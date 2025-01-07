import { FeatureStatus } from '~/server/services/feature-status.service';
import styles from './FeatureStatusList.module.scss';
import { ActionIcon, Badge } from '@mantine/core';
import { IconPencil, IconPlus } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { FeatureStatusModal } from '~/components/FeatureStatus/FeatureStatusModal';

export function FeatureStatusList({ data }: { data?: FeatureStatus[] }) {
  return (
    <div className={styles.grid}>
      <div className={styles.contents}>
        <strong>Feature</strong>
        <strong>Status</strong>
        <strong>Message</strong>
        <div>
          <ActionIcon
            onClick={() =>
              dialogStore.trigger({
                component: FeatureStatusModal,
                props: {},
              })
            }
          >
            <IconPlus />
          </ActionIcon>
        </div>
      </div>
      {!data?.length ? (
        <div className="flex items-center justify-center p-3">
          No feature statuses have been created yet
        </div>
      ) : (
        data.map((item) => <FeatureStatusListItem key={item.feature} {...item} />)
      )}
    </div>
  );
}

function FeatureStatusListItem(item: FeatureStatus) {
  return (
    <div className={styles.contents}>
      <div>{item.feature}</div>
      <div>
        {item.disabled && !item.resolvedAt ? (
          <Badge color="red">Disabled</Badge>
        ) : (
          <Badge color="green">Enabled</Badge>
        )}
      </div>
      <div>{!item.resolvedAt && item.message}</div>
      <div>
        <ActionIcon
          onClick={() =>
            dialogStore.trigger({
              component: FeatureStatusModal,
              props: item,
            })
          }
        >
          <IconPencil />
        </ActionIcon>
      </div>
    </div>
  );
}
