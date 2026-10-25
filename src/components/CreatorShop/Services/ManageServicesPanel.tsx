import {
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Paper,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconDots, IconEyeOff, IconLock, IconPlus } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import {
  pluralize,
  useMutateMyServices,
  useQueryMyServices,
} from '~/components/CreatorShop/Services/creator-service.util';
import { PublishServiceModal } from '~/components/CreatorShop/Services/SellerAffirmation';
import { ServiceOfferingFormModal } from '~/components/CreatorShop/Services/ServiceOfferingFormModal';
import { ServiceDealsList } from '~/components/CreatorShop/Services/deals/ServiceDealsList';
import { ServiceRatingBadge } from '~/components/CreatorShop/Services/ServiceRatingBadge';
import { useSyncAccount } from '~/hooks/useSyncAccount';
import { useServerDomains } from '~/providers/AppProvider';
import { useRouter } from 'next/router';
import { useDomainColor } from '~/hooks/useDomainColor';
import { Currency, ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

const statusBadge: Record<ServiceOfferingStatus, { color: string; label: string }> = {
  Draft: { color: 'gray', label: 'Draft' },
  Active: { color: 'green', label: 'Active' },
  Paused: { color: 'yellow', label: 'Paused' },
  Removed: { color: 'red', label: 'Removed' },
};

const openForm = (offering?: ServiceOffering) =>
  dialogStore.trigger({ component: ServiceOfferingFormModal, props: { offering } });

export type ShopPublishState = { onPublish: () => void; publishing: boolean };

/** `unpublishedShop` is set only while the seller's Creator Shop is known to be a draft. */
export function ManageServicesPanel({ unpublishedShop }: { unpublishedShop?: ShopPublishState }) {
  const { eligibility, offerings, hiddenOffDomain, isLoading } = useQueryMyServices(true);
  const router = useRouter();
  const redDomain = useServerDomains().red;
  const syncAccount = useSyncAccount();

  if (isLoading)
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );

  const canSell = eligibility?.canSell ?? false;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={2}>
          <Title order={2}>Services</Title>
          <Text c="dimmed">
            Offer work on commission. Buzz sits in escrow until the buyer approves your delivery.
          </Text>
        </Stack>
        {canSell && (
          <Button leftSection={<IconPlus size={16} />} color="yellow" onClick={() => openForm()}>
            New service
          </Button>
        )}
      </Group>

      {eligibility && !canSell && <SellGate eligibility={eligibility} />}

      <Stack gap="xs">
        <Title order={3}>Incoming requests</Title>
        <ServiceDealsList
          role="seller"
          status="open"
          emptyText="No open requests. They show up here when a buyer requests one of your services."
        />
      </Stack>

      <Title order={3}>Your services</Title>

      {offerings.length > 0 && (
        <Stack gap="sm">
          {offerings.map((offering) => (
            <OfferingRow
              key={offering.id}
              offering={offering}
              canSell={canSell}
              unpublishedShop={unpublishedShop}
            />
          ))}
        </Stack>
      )}
      {hiddenOffDomain > 0 && (
        <Text size="sm" c="dimmed">
          <Anchor href={syncAccount(`//${redDomain}${router.asPath}`)} inherit>
            {pluralize(hiddenOffDomain, 'mature service')}: manage on civitai.red
          </Anchor>
        </Text>
      )}
      {offerings.length === 0 && hiddenOffDomain === 0 && canSell && (
        <Paper withBorder radius="md" p="xl">
          <Text ta="center" c="dimmed">
            No services yet. Create one to show it in your shop.
          </Text>
        </Paper>
      )}
    </Stack>
  );
}

function SellGate({
  eligibility,
}: {
  eligibility: NonNullable<ReturnType<typeof useQueryMyServices>['eligibility']>;
}) {
  const { current, min } = eligibility.score;
  return (
    <Paper withBorder radius="md" p="md">
      <Group wrap="nowrap" align="flex-start">
        <ThemeIcon size={44} radius="md" variant="light" color="gray">
          <IconLock size={22} />
        </ThemeIcon>
        <Stack gap={6} className="flex-1">
          <Text fw={600}>Services unlock at Beacon ({min.toLocaleString()} Creator Score)</Text>
          {eligibility.standingIssue ? (
            <Text size="sm" c="dimmed">
              {eligibility.standingIssue}
            </Text>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                Same point you can join the Creator Program. You&apos;re at{' '}
                {Math.floor(current).toLocaleString()}.
              </Text>
              <Progress value={Math.min(100, (current / min) * 100)} color="yellow" size="sm" />
            </>
          )}
        </Stack>
      </Group>
    </Paper>
  );
}

function OfferingRow({
  offering,
  canSell,
  unpublishedShop,
}: {
  offering: ServiceOffering;
  canSell: boolean;
  unpublishedShop?: ShopPublishState;
}) {
  const { setStatus, remove } = useMutateMyServices();
  const domain = useDomainColor();
  const badge = statusBadge[offering.status];
  const isActive = offering.status === ServiceOfferingStatus.Active;

  const confirmRemove = () =>
    openConfirmModal({
      title: 'Remove service',
      children: (
        <Text size="sm">
          &quot;{offering.title}&quot; leaves your shop for good. Open deals are not affected.
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate({ id: offering.id }),
    });

  return (
    <Paper withBorder radius="md" p="md">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Stack gap={2} className="min-w-0">
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} lineClamp={1}>
              {offering.title}
            </Text>
            <Badge color={badge.color} variant="light" radius="sm">
              {badge.label}
            </Badge>
            <ServiceRatingBadge rating={offering.maxNsfwLevel} />
          </Group>
          <Text size="sm" c="dimmed">
            ~{pluralize(offering.deliveryDays, 'day')} ·{' '}
            {pluralize(offering.revisionsIncluded, 'revision')}
            {offering.maxOpenDeals ? ` · ${pluralize(offering.maxOpenDeals, 'open slot')}` : ''}
          </Text>
        </Stack>
        <Group gap="sm" wrap="nowrap">
          <CurrencyBadge
            currency={Currency.BUZZ}
            type={domain === 'green' ? 'green' : 'yellow'}
            unitAmount={offering.price}
            variant="transparent"
          />
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button variant="subtle" color="gray" size="compact-sm" aria-label="Service actions">
                <IconDots size={16} />
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {canSell && <Menu.Item onClick={() => openForm(offering)}>Edit</Menu.Item>}
              {isActive ? (
                <Menu.Item onClick={() => setStatus.mutate({ id: offering.id, status: 'Paused' })}>
                  Pause
                </Menu.Item>
              ) : (
                canSell && (
                  <Menu.Item
                    onClick={() =>
                      offering.termsAffirmed
                        ? setStatus.mutate({ id: offering.id, status: 'Active' })
                        : dialogStore.trigger({
                            component: PublishServiceModal,
                            props: { offering },
                          })
                    }
                  >
                    Publish
                  </Menu.Item>
                )
              )}
              <Menu.Item color="red" onClick={confirmRemove}>
                Remove
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      {isActive && unpublishedShop && (
        <Alert color="yellow" icon={<IconEyeOff size={18} />} p="xs" mt="sm">
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm">Buyers can&apos;t see this until you publish your shop.</Text>
            <Button
              size="compact-sm"
              color="yellow"
              loading={unpublishedShop.publishing}
              onClick={unpublishedShop.onPublish}
            >
              Publish shop
            </Button>
          </Group>
        </Alert>
      )}
    </Paper>
  );
}
