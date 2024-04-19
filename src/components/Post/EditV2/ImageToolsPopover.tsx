import { Input, Popover } from '@mantine/core';
import React, { useState } from 'react';
import { ControlledImage, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { trpc } from '~/utils/trpc';

export function ImageToolsPopover({
  children,
  image,
}: {
  children: React.ReactElement;
  image: ControlledImage;
}) {
  const { data: tools, isLoading } = trpc.tool.getAll.useQuery();
  const [updateImage] = usePostEditStore((state) => [state.updateImage]);
  const [search, setSearch] = useState('');

  return (
    <Popover position="bottom-start">
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown className="p-3">
        <div className="flex flex-col gap-3">
          <Input value={search} onChange={(value) => setSearch(e.target.value)} />
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
