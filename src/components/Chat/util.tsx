import { Anchor, Text } from '@mantine/core';
import type { IntermediateRepresentation, OptFn, Opts } from 'linkifyjs';
import type { ReactElement } from 'react';
import React from 'react';
import { constants } from '~/server/common/constants';
import { NextLink as Link } from '~/components/NextLink/NextLink';

export const getLinkHref = (href: string | undefined) => {
  if (!href) return;

  if (constants.chat.externalRegex.test(href)) return href;

  let newHref: string;
  const airMatch = href.match(constants.chat.airRegex);
  if (airMatch && airMatch.groups) {
    const { mId, mvId } = airMatch.groups;
    newHref = `/models/${mId}?modelVersionId=${mvId}`;
  } else {
    newHref = href.replace(constants.chat.civRegex, '') || '/';
  }
  return newHref;
};

const renderLink: OptFn<(ir: IntermediateRepresentation) => ReactElement | undefined> = ({
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
        sx={{ textDecoration: 'underline', color: 'unset' }}
        {...props}
      >
        {content}
      </Anchor>
    );
  }

  return (
    // TODO: In a perfect world, we wouldn't be relying on Mantine here.
    <Link legacyBehavior href={modHref} passHref {...props}>
      <Text variant="link" component="a" sx={{ textDecoration: 'underline', color: 'unset' }}>
        {content}
      </Text>
    </Link>
  );
};
const validateLink = {
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
