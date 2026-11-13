import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentDomainHref } from '~/hooks/useCurrentDomainHref';
import { getDomainLinkLabel, sortDomainLinks } from '~/utils/domain-link';

/**
 * A creator's profile links as icons. A path link to one of our sites opens on the site being
 * read, so a civitai.com/user/x link keeps a civitai.red reader on civitai.red.
 */
export function DomainLinkIcons({
  links,
  size,
  iconSize,
}: {
  links: { url: string }[];
  size: number;
  iconSize: number;
}) {
  const toCurrentDomain = useCurrentDomainHref();
  return (
    <>
      {sortDomainLinks(links).map((link, index) => (
        <LegacyActionIcon
          key={index}
          component="a"
          href={toCurrentDomain(link.url)}
          target="_blank"
          rel="nofollow noreferrer"
          size={size}
          aria-label={getDomainLinkLabel(link)}
        >
          <DomainIcon domain={link.domain} size={iconSize} />
        </LegacyActionIcon>
      ))}
    </>
  );
}
