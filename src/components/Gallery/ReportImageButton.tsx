import React, { cloneElement } from 'react';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';

export const ReportImageButton = ({
  children,
  imageId,
}: {
  children: React.ReactElement;
  imageId: number;
}) => {
  const handleClick = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContext('report', { entityType: ReportEntity.Image, entityId: imageId });
  };

  return cloneElement(children, { onClick: handleClick });
};
