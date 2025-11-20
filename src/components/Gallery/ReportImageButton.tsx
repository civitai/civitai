import type React from 'react';
import { cloneElement } from 'react';
import { openReportModal } from '~/components/Dialog/triggers/report';
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
    openReportModal({ entityType: ReportEntity.Image, entityId: imageId });
  };

  return cloneElement(children, { onClick: handleClick });
};
