import { Anchor, Badge, Button, Card, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconBolt, IconPlugConnected, IconSettings, IconShieldLock } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import {
  isMarketplaceCategory,
  MARKETPLACE_CATEGORY_LABELS,
} from '~/server/services/blocks/marketplace-categories.constants';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * Marketplace card for an approved app block. Renders the block name,
 * a short description (from manifest.description), the slot it targets,
 * publisher/app attribution, install count, and an install/manage CTA.
 *
 * The install CTA opens the per-app settings panel; we delegate the open
 * action to the parent via `onOpen` so the page owns the modal lifecycle.
 */
export interface AppBlockCardProps {
  block: AvailableBlock;
  alreadySubscribed: boolean;
  onOpen: (block: AvailableBlock) => void;
  /**
   * Lifetime publisher share for this app, in cents. Rendered as an
   * "Earning" chip on cards owned by the current user. Undefined =
   * not owned by the viewer; 0 = owned but no earnings yet (no chip).
   */
  ownedEarningCents?: number;
}

function slotLabel(slotId?: string): string {
  switch (slotId) {
    case 'model.sidebar_top':
      return 'Model sidebar';
    case 'model.below_images':
      return 'Below images';
    case 'model.actions_extra':
      return 'Model actions';
    default:
      return slotId ?? 'Unknown slot';
  }
}

/**
 * Maps a stored category value to its display label. Falls back to the raw
 * value for an unrecognised category (soft contract — adding a category is a
 * one-line const edit, and an older client won't crash on a newer category).
 */
function categoryLabel(category: string): string {
  return isMarketplaceCategory(category) ? MARKETPLACE_CATEGORY_LABELS[category] : category;
}

/** Human label for a scope id (the permission disclosure), falling back to the
 * raw id for an unknown scope so a new scope ships without breaking the card. */
function scopeLabel(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? scope;
}

export function AppBlockCard({
  block,
  alreadySubscribed,
  onOpen,
  ownedEarningCents,
}: AppBlockCardProps) {
  const manifest = block.manifest as {
    name?: string;
    description?: string;
    targets?: Array<{ slotId?: string }>;
  };
  const [busy] = useState(false);
  const slot = manifest.targets?.[0]?.slotId;
  return (
    <Card shadow="sm" padding="md" radius="md" withBorder className="h-full">
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            {/*
              F-E E2: the card title links to the per-app detail page
              (/apps/<appBlockId>). Install stays the secondary action below.
            */}
            <Anchor
              component={Link}
              href={`/apps/${block.id}`}
              underline="never"
              c="inherit"
            >
              <Title order={4} className="line-clamp-2">
                {manifest.name ?? block.blockId}
              </Title>
            </Anchor>
            <Text size="xs" c="dimmed">
              by {block.appName ?? block.appId}
            </Text>
          </Stack>
          <Stack gap={4} align="flex-end">
            <Badge variant="light" color="blue" size="sm">
              {slotLabel(slot)}
            </Badge>
            {/* F-E E3: mod-assigned marketplace category. NULL until the E3
                migration is applied + a mod sets one (dark today) → no chip. */}
            {block.category && (
              <Badge variant="light" color="grape" size="sm">
                {categoryLabel(block.category)}
              </Badge>
            )}
            {ownedEarningCents != null && ownedEarningCents > 0 && (
              <Badge variant="light" color="green" size="sm">
                Earning ${(ownedEarningCents / 100).toFixed(2)}
              </Badge>
            )}
          </Stack>
        </Group>
        {manifest.description && (
          <Anchor component={Link} href={`/apps/${block.id}`} underline="never" c="inherit">
            <Text size="sm" c="dimmed" className="line-clamp-3">
              {manifest.description}
            </Text>
          </Anchor>
        )}
        {/* F-E E3: permission preview — the FIRST N approved scopes (the same
            public disclosure list the E2 detail page shows in full). Lets a
            viewer see what the app can do BEFORE installing (closes H3 at the
            card level). Empty until the app is approved with scopes. */}
        {block.scopesSummary.length > 0 && (
          <Group gap={4} wrap="wrap">
            <IconShieldLock size={14} className="text-gray-500" />
            {block.scopesSummary.map((scope) => (
              <Tooltip key={scope} label={scopeLabel(scope)} withArrow multiline w={220}>
                <Badge variant="outline" color="gray" size="xs" style={{ cursor: 'help' }}>
                  {scope}
                </Badge>
              </Tooltip>
            ))}
          </Group>
        )}
        <Group justify="space-between" mt="auto" pt="xs">
          <Group gap={4}>
            <IconBolt size={14} />
            <Text size="xs" c="dimmed">
              {block.installCount.toLocaleString()} installs
            </Text>
          </Group>
          {/*
            Anon-conversion CTA (F-E E1): for a session-less viewer, clicking
            Install opens the LoginModal (via LoginRedirect → requireLogin →
            dialogStore.trigger(LoginModal, { returnUrl })) instead of the
            install/settings modal — installing requires auth. For a logged-in
            viewer LoginRedirect is a pass-through and the onClick runs
            normally. This is dark today (the page is mod-gated); it only
            matters once the segment is widened to anon.
          */}
          <LoginRedirect reason="perform-action">
            <Button
              size="xs"
              variant={alreadySubscribed ? 'default' : 'filled'}
              leftSection={
                alreadySubscribed ? <IconSettings size={14} /> : <IconPlugConnected size={14} />
              }
              loading={busy}
              onClick={() => onOpen(block)}
            >
              {alreadySubscribed ? 'Manage' : 'Install'}
            </Button>
          </LoginRedirect>
        </Group>
      </Stack>
    </Card>
  );
}
