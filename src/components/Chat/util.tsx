import { Anchor, Text } from '@mantine/core';
import type { IntermediateRepresentation, OptFn, Opts } from 'linkifyjs';
import type { ReactElement } from 'react';
import React from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { constants } from '~/server/common/constants';
import { stripStickerTokens } from '~/shared/utils/sticker-token';
import { getModelUrl } from '~/utils/string-helpers';

export const getLinkHref = (href: string | undefined) => {
  if (!href) return;

  if (constants.chat.externalRegex.test(href)) return href;

  let newHref: string;
  const airMatch = href.match(constants.chat.airRegex);
  if (airMatch && airMatch.groups) {
    const { mId, mvId } = airMatch.groups;
    newHref = getModelUrl({ modelId: Number(mId), modelVersionId: Number(mvId) });
  } else {
    newHref = href.replace(constants.chat.civRegex, '') || '/';
  }
  return newHref;
};

export const renderLink: OptFn<(ir: IntermediateRepresentation) => ReactElement | undefined> = ({
  attributes,
  content,
}) => {
  const { href, ...props }: { href?: string } = attributes;

  const modHref = getLinkHref(href);
  if (!modHref) return;

  if (constants.chat.externalRegex.test(modHref)) {
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
export const validateLink = {
  url: (value: string) =>
    constants.chat.civRegex.test(value) ||
    constants.chat.airRegex.test(value) ||
    constants.chat.externalRegex.test(value),
};

export const linkifyOptions: Opts = {
  render: renderLink,
  validate: validateLink,
};

export const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);

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
  const text = stripStickerTokens(message.content);
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
