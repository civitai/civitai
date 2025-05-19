import { Anchor, Text } from '@mantine/core';
import type { IntermediateRepresentation, OptFn, Opts } from 'linkifyjs';
import pluralize from 'pluralize';
import React, { ReactElement } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { constants } from '~/server/common/constants';
import blockedWords from '~/utils/metadata/lists/blocklist-dms.json';

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

const wordReplace = (word: string) => {
  return word
    .replace(/i/g, '[i|l|1]')
    .replace(/o/g, '[o|0]')
    .replace(/s/g, '[s|z]')
    .replace(/e/g, '[e|3]');
};

export const chatBlocklist = (blockedWords as [string, boolean][])
  .map(([word, isUrl]) => {
    if (isUrl) return [new RegExp(`.*${word}.*`, 'i')];
    const modWord = wordReplace(word);
    const pluralWord = wordReplace(pluralize(word));
    return [new RegExp(`\\b${modWord}\\b`, 'i'), new RegExp(`\\b${pluralWord}\\b`, 'i')];
  })
  .flat();

export const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);
