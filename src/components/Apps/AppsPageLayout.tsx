import { Container, Group, Stack, Text, Title } from '@mantine/core';
import type { MantineSize } from '@mantine/core';
import type { ReactNode } from 'react';
import { AppsSubNav } from '~/components/Apps/AppsSubNav';

/**
 * Shared chrome for every `/apps/*` surface.
 *
 * THE POINT: the {@link AppsSubNav} tabs must sit in the IDENTICAL vertical
 * position on every apps page. Before this, each page hand-rolled its own
 * `Container size=… py=…` + a per-page title block placed ABOVE or AROUND the
 * sub-nav, so the tabs jumped around as you navigated between surfaces. This
 * layout fixes the tabs as the FIRST element of the page header region — so they
 * land in the same vertical position every time — and renders the optional
 * per-page title/actions BELOW them. (No sticky positioning: the requirement is
 * a CONSISTENT position across pages, which the uniform "tabs first" order
 * already delivers; pinning the band on scroll risks colliding with the global
 * app-shell header and was unverified.)
 *
 * Each page wraps its body in `<AppsPageLayout …>{body}</AppsPageLayout>`,
 * dropping its own `Container` + ad-hoc sub-nav placement. The per-page title,
 * subtitle and right-aligned header actions become props so the header geometry
 * is uniform; only the content slot differs.
 *
 * Flag-gating (`features.appBlocks`) + any per-page access redirect stay on the
 * page (`getServerSideProps` / the in-component `NotFound` guard) — this layout
 * is presentational chrome only and assumes the page already passed its gate.
 */
export function AppsPageLayout({
  title,
  subtitle,
  actions,
  size = 'xl',
  children,
}: {
  /** Page heading (omit for a header with just the tabs, e.g. the marketplace). */
  title?: ReactNode;
  /** Optional dimmed sub-heading rendered under the title. */
  subtitle?: ReactNode;
  /** Right-aligned header controls (e.g. a "Submit a new app" button). */
  actions?: ReactNode;
  /** Container width — pages keep their prior size (`sm` for Submit, etc.). */
  size?: MantineSize;
  children: ReactNode;
}) {
  const hasHeader = Boolean(title || subtitle || actions);
  return (
    <Container size={size} py="md">
      <Stack gap="lg">
        {/*
          Page header region. The sub-nav tabs are the FIRST child here and
          carry no leading content, so they land in the same spot on every page
          regardless of whether a per-page title is present. The title/actions
          render BELOW the tabs (never above), which is what keeps the tabs from
          shifting vertically between surfaces.
        */}
        <Stack
          gap="md"
          py="sm"
          style={(theme) => ({
            // Hairline divider so the header reads as a band.
            borderBottom: `1px solid ${theme.colors.dark[4]}`,
          })}
        >
          <AppsSubNav />
          {hasHeader && (
            <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
              <Stack gap={4} style={{ minWidth: 0 }}>
                {title && <Title order={2}>{title}</Title>}
                {subtitle && (
                  <Text c="dimmed" size="sm">
                    {subtitle}
                  </Text>
                )}
              </Stack>
              {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
            </Group>
          )}
        </Stack>

        {children}
      </Stack>
    </Container>
  );
}
