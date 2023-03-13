import {
  ActionIcon,
  Box,
  Button,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Group,
  Indicator,
  MultiSelect,
  Popover,
  ScrollArea,
  SegmentedControl,
  Stack,
} from '@mantine/core';
import { ImageGenerationProcess, MetricTimeframe } from '@prisma/client';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconFilterOff,
} from '@tabler/icons';
import { deleteCookie } from 'cookies-next';
import { useRouter } from 'next/router';
import { useRef, useState, useEffect } from 'react';
import z from 'zod';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { galleryFilterSchema, useCookies } from '~/providers/CookiesProvider';
import { constants } from '~/server/common/constants';
import { BrowsingMode, ImageResource, ImageSort, TagSort } from '~/server/common/enums';
import { setCookie } from '~/utils/cookies-helpers';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
