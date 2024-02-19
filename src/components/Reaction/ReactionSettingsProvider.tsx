import { BadgeProps, ButtonProps } from '@mantine/core';
import { useContext, createContext, ReactNode } from 'react';

type ReactionSettingsState = {
  hideReactionCount?: boolean;
  buttonStyling?: Omit<ButtonProps, 'onClick'> & BadgeProps;
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
