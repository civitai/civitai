import type { MantineColor } from '@mantine/core';
import type { RouterOutput } from '~/types/router';
import type { CommentEntityType } from '~/shared/utils/prisma/enums';

export type CommentV3Section = RouterOutput['commentv3']['getSection'];
export type CommentV3Comment = CommentV3Section['comments'][number];
export type CommentV3SurfaceType = CommentEntityType;

export type CommentV3Badge = { userId: number; label: string; color: MantineColor };
