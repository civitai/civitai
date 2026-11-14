import { Anchor, Text } from '@mantine/core';
import type { IntermediateRepresentation, OptFn, Opts } from 'linkifyjs';
import type { ReactElement } from 'react';
import React from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { constants } from '~/server/common/constants';
import { stripStickerTokens } from '~/shared/utils/sticker-token';
import { getModelUrl } from '~/utils/string-helpers';

/**
 * Parse a chat link. linkify may hand over a bare `host/path`, which is read as https.
 * Null when it does not parse or carries credentials (`user:pass@host`).
 */
const parseChatLink = (value: string) => {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  return url;
};

/**
 * Linked as written and opened in a new tab: the allowlisted third-party hosts, and our other
 * sites (`ownHosts` from the domain config, less this deployment's own `civHosts`). Each of our
 * sites shows content the others may not, so a link to one keeps its host.
 */
export const isExternalChatLink = (href: string, ownHosts: readonly string[]) => {
  const url = parseChatLink(href);
  if (!url) return false;
  const host = url.hostname;
  if (constants.chat.externalHosts.includes(host)) return true;
  // Like `externalHosts`, an own site is linked with or without "www.".
  const site = host.replace(/^www\./, '');
  return ownHosts.includes(site) && !constants.chat.civHosts.includes(site);
};

// The URL parser folds "\" and dot segments into "//"; reject a leading "//" (another host).
// The "\" check is kept as defence in depth.
const isSameSitePath = (path: string) => path === '/' || /^\/[^/\\]/.test(path);

const civitaiChatLinkPath = (href: string) => {
  const url = parseChatLink(href);
  if (!url || !constants.chat.civHosts.includes(url.hostname)) return null;
  const path = `${url.pathname}${url.search}${url.hash}` || '/';
  return isSameSitePath(path) ? path : null;
};

export const getLinkHref = (href: string | undefined, ownHosts: readonly string[]) => {
  if (!href) return;

  if (isExternalChatLink(href, ownHosts)) return href;

  const airMatch = href.match(constants.chat.airRegex);
  if (airMatch && airMatch.groups) {
    const { mId, mvId } = airMatch.groups;
    return getModelUrl({ modelId: Number(mId), modelVersionId: Number(mvId) });
  }

  // Anything off the allowlist gets no link at all.
  return civitaiChatLinkPath(href) ?? undefined;
};

const chatLinkRenderer = (
  ownHosts: readonly string[]
): OptFn<(ir: IntermediateRepresentation) => ReactElement> =>
  function ChatLink({ attributes, content }) {
    const { href, ...props }: { href?: string } = attributes;

    const modHref = getLinkHref(href, ownHosts);
    // linkify-react reads `.props` off whatever this returns, so plain text still needs an element.
    if (!modHref) return <>{content}</>;

    if (isExternalChatLink(modHref, ownHosts)) {
      // TODO: In a perfect world, we wouldn't be relying on Mantine here.
      return (
        <Anchor
          href={modHref}
          target="_blank"
          rel="noopener noreferrer"
          variant="link"
          style={{ textDecoration: 'underline', color: 'unset' }}
          {...props}
        >
          {content}
        </Anchor>
      );
    }

    return (
      // TODO: In a perfect world, we wouldn't be relying on Mantine here.
      <Link legacyBehavior href={modHref} passHref {...props}>
        <Text c="blue.4" component="a" style={{ textDecoration: 'underline', color: 'unset' }}>
          {content}
        </Text>
      </Link>
    );
  };

// This is the whole allowlist for what chat will fetch. `chat.service.ts` runs
// `findLinks` with these options server-side and unfurls whatever they return, so a
// domain absent here is never turned into a link and never fetched. Asked and answered
// 2026-08-26: there is no arbitrary-URL fetch behind DM link previews.
export const isChatLink = (value: string, ownHosts: readonly string[]) =>
  civitaiChatLinkPath(value) !== null ||
  constants.chat.airRegex.test(value) ||
  isExternalChatLink(value, ownHosts);

const optionsByHosts = new Map<string, Opts>();

/** Linkify options for chat. `ownHosts` is every host our sites answer on (`getOwnHosts`). */
export const chatLinkifyOptions = (ownHosts: readonly string[]): Opts => {
  const key = ownHosts.join(',');
  let options = optionsByHosts.get(key);
  if (!options) {
    options = {
      render: chatLinkRenderer(ownHosts),
      // A type missing from an object `validate` passes, so anything but a url (an email) is text.
      validate: (value, type) => type === 'url' && isChatLink(value, ownHosts),
    };
    optionsByHosts.set(key, options);
  }
  return options;
};

export const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);

/** Markdown the one-line preview would otherwise show raw: links, bold and inline code. */
export const stripMarkdownForPreview = (text: string) =>
  text
    // An escaped character (a group-rename note escapes the name) is held out of the rules below
    // and put back as itself, as markdown reads it.
    .replace(/\\([\\`*_[\]()<>!#~|])/g, (_, char: string) => `\uE000${char.charCodeAt(0)}\uE001`)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\uE000(\d+)\uE001/g, (_, code: string) => String.fromCharCode(Number(code)));

/**
 * The last-message line in a chat list row, with who said it.
 *
 * A 1:1 message from the other person stays bare: the row's title already names them. Your own
 * message is "You: …", and in a group the sender's username leads, since the title is the group.
 */
export const chatPreviewText = ({
  message,
  viewerId,
  otherMembers,
}: {
  message: { content: string; userId: number };
  viewerId: number | undefined;
  otherMembers: { userId: number; user: { username: string | null } }[];
}) => {
  const text = stripMarkdownForPreview(stripStickerTokens(message.content));
  if (message.userId === viewerId) return `You: ${text}`;
  if (otherMembers.length > 1) {
    const sender = otherMembers.find((cm) => cm.userId === message.userId)?.user.username;
    if (sender) return `${sender}: ${text}`;
  }
  return text;
};

/** The 2023 seed row for the Moderator badge cosmetic (`Cosmetic.id`). */
export const MODERATOR_BADGE_COSMETIC_ID = 5;

/**
 * Whether the chat header should add its own moderator mark beside a member's name. A moderator
 * wearing the Moderator badge already shows that mark through their equipped badge, so a second one
 * would double it; a non-moderator wearing the badge still gets nothing from the chat.
 */
export const showsChatModeratorMark = (user: {
  isModerator?: boolean | null;
  cosmetics?: { cosmetic: { id: number; type: string } | null }[];
}) =>
  user.isModerator === true &&
  !user.cosmetics?.some(
    ({ cosmetic }) => cosmetic?.type === 'Badge' && cosmetic.id === MODERATOR_BADGE_COSMETIC_ID
  );
