import { openConfirmModal } from '@mantine/modals';
import {
  ExternalLinkWarningBody,
  ExternalLinkWarningTitle,
} from '~/components/ExternalLinkWarning/ExternalLinkWarning';

/**
 * 🔴 `noopener` is not cosmetic here: without it the destination gets a live `window.opener`
 * handle back to the Civitai tab and can navigate it.
 */
export function openExternalLinkWarning(href: string) {
  openConfirmModal({
    title: <ExternalLinkWarningTitle />,
    centered: true,
    labels: { cancel: 'Cancel', confirm: 'Continue' },
    children: <ExternalLinkWarningBody href={href} />,
    onConfirm: () => {
      window.open(href, '_blank', 'noopener,noreferrer');
    },
  });
}
