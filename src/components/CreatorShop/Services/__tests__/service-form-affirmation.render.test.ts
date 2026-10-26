import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import type * as Mantine from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// Publishing from the form is the main way a service goes live: it must ask for the seller's
// confirmation unless the current one is already on file.

vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof Mantine>()),
  Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorService.upsert': {
      useMutation: () => ({ mutateAsync: () => undefined, isPending: false }),
    },
  }),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));

const { ServiceOfferingFormModal } = await import(
  '~/components/CreatorShop/Services/ServiceOfferingFormModal'
);

const draft = {
  id: 1,
  title: 'Badge',
  description: 'A badge',
  status: 'Draft',
  price: 500,
  deliveryDays: 5,
  revisionsIncluded: 1,
  maxOpenDeals: 3,
  maxNsfwLevel: 2,
  previewKind: 'Image',
};

const render = (offering?: object) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ServiceOfferingFormModal, { offering } as never)
    )
  );

const publishButton = (html: string) =>
  html.match(/<button[^>]*>(?:(?!<\/button>).)*Publish service/)?.[0] ?? '';

describe('publishing from the service form', () => {
  it('asks a new service for the confirmation, with Publish disabled until it is ticked', () => {
    const html = render();
    expect(html).toContain('I confirm that:');
    expect(publishButton(html)).toContain('disabled');
  });

  it('asks a draft with no confirmation on file', () => {
    expect(render({ ...draft, termsAffirmed: false })).toContain('I confirm that:');
  });

  it('does not ask again once the current confirmation is on file', () => {
    const html = render({ ...draft, termsAffirmed: true });
    expect(html).not.toContain('I confirm that:');
    expect(publishButton(html)).not.toContain('disabled');
  });
});
