import { FeatureStatus } from '~/server/services/feature-status';
import styles from './FeatureStatusList.module.scss';
import { ActionIcon, Badge, Checkbox } from '@mantine/core';
import { IconCopy, IconPlus } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { FeatureStatusModal } from '~/components/FeatureStatus/FeatureStatusModal';
import { trpc } from '~/utils/trpc';
import clsx from 'clsx';

export function FeatureStatusList({ data }: { data?: FeatureStatus[] }) {
  return (
    <div className={styles.grid}>
      <div className={styles.contents}>
        <strong>Feature</strong>
        <strong>Status</strong>
        {/* <strong>Active</strong> */}
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
  // const queryUtils = trpc.useUtils();
  // const { mutate, isLoading } = trpc.featureStatus.resolveFeatureStatus.useMutation({
  //   onSuccess: () => {
  //     queryUtils.featureStatus.getFeatureStatusesDistinct.invalidate();
  //   },
  // });

  return (
    <div className={styles.contents}>
      <div>{item.feature}</div>
      <div>
        <span className={clsx({ ['opacity-25']: !!item.resolvedAt })}>
          {item.disabled ? (
            <Badge color="red">Disabled</Badge>
          ) : (
            <Badge color="green">Enabled</Badge>
          )}
        </span>
      </div>
      {/* <div className="flex justify-center">
        <Checkbox
          key={item.resolvedAt ? item.resolvedAt.toString() : undefined}
          defaultChecked={!item.resolvedAt}
          disabled={isLoading}
          onChange={(e) => mutate({ id: item.id, resolved: !e.currentTarget.checked })}
        />
      </div> */}
      <div>
        <span className={clsx({ ['opacity-25']: !!item.resolvedAt })}>{item.message}</span>
      </div>
      <div>
        <ActionIcon
          onClick={() =>
            dialogStore.trigger({
              component: FeatureStatusModal,
              props: item,
            })
          }
        >
          <IconCopy />
        </ActionIcon>
      </div>
    </div>
  );
}
