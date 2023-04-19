import React from 'react';

type LayoutElement = (page: React.ReactElement) => React.ReactElement;

export const nestLayout =
  (parent: LayoutElement, child: LayoutElement) => (page: React.ReactElement) =>
    parent(child(page));
