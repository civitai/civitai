import React from 'react';
import { useEntityAccessRequirement } from '../Club/club.utils';
import { SupportedClubEntities } from '../../server/schema/club.schema';

export const ResourceAccessWrap = ({
  entityType,
  entityId,
  children,
  fallback,
}: {
  entityId: number;
  entityType: SupportedClubEntities;
  children: React.ReactElement | JSX.Element;
  fallback?: React.ReactElement | JSX.Element;
}) => {
  const { entities } = useEntityAccessRequirement({
    entityType,
    entityIds: [entityId],
  });

  const [access] = entities;
  const hasAccess = access?.hasAccess;

  if (!hasAccess) {
    return fallback ?? null;
  }

  return children;
};
