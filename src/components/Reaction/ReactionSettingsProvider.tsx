import type { BadgeProps, ButtonProps } from '@mantine/core';
import type { ReactNode } from 'react';
import { useContext, createContext } from 'react';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

type ReactionSettingsState = {
  hideReactions?: boolean;
  hideReactionCount?: boolean;
  buttonStyling?: (
    reaction: ReviewReactions | 'AddReaction' | 'BuzzTip',
    hasReacted?: boolean
  ) => Omit<ButtonProps, 'onClick'> & BadgeProps;
};

const ReactionSettingsContext = createContext<ReactionSettingsState | null>(null);
export const useReactionSettingsContext = () => {
  const context = useContext(ReactionSettingsContext);
  return context ?? {};
};

export const ReactionSettingsProvider = ({
  children,
  settings,
}: {
  children: ReactNode;
  settings: ReactionSettingsState;
}) => {
  return (
    <ReactionSettingsContext.Provider value={settings}>{children}</ReactionSettingsContext.Provider>
  );
};
