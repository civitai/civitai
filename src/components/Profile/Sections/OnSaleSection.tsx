import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconTag } from '@tabler/icons-react';
import React from 'react';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ModelCardContextProvider, useModelSaleBadges } from '~/components/Cards/ModelCardContext';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { useQueryModels } from '~/components/Model/model.utils';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { ModelSort } from '~/server/common/enums';

const ON_SALE_DISPLAY = 32;

/**
 * Opt-in, and off by default: a creator running no sales would otherwise get an empty section on their
 * profile, and one who runs them rarely would get a section that appears and vanishes without them
 * touching anything.
 */
export const OnSaleSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-on-sale-section' });
  const { models, isLoading } = useQueryModels(
    {
      limit: ON_SALE_DISPLAY,
      username: user.username,
      onSale: true,
      sort: ModelSort.Newest,
    },
    { keepPreviousData: true, enabled: inView }
  );

  // Every card in this section is on sale by definition, so without the shared map it was the worst
  // offender: one request per card, 32 of them.
  const salesByModelId = useModelSaleBadges(models.map((m) => m.id));

  const isNullState = !isLoading && !models.length;

  if (isNullState) return null;

  return (
    <div
      ref={ref}
      className={isNullState ? undefined : classes.profileSection}
      style={
        {
          '--count': models.length,
          '--row-count': 2,
          '--width-grid': '280px',
        } as React.CSSProperties
      }
    >
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview rowCount={2} />
        ) : (
          <ProfileSection
            title="On sale"
            icon={<IconTag />}
            action={
              <Link legacyBehavior href={`/user/${user.username}/models?onSale=true`} passHref>
                <Button
                  h={34}
                  component="a"
                  variant="subtle"
                  rightSection={<IconArrowRight size={16} />}
                >
                  <Text inherit> View all models</Text>
                </Button>
              </Link>
            }
          >
            <ModelCardContextProvider hasSaleProvider salesByModelId={salesByModelId}>
              <ShowcaseGrid itemCount={models.length} rows={2}>
                {models.map((model) => (
                  <ModelCard data={model} key={model.id} />
                ))}
              </ShowcaseGrid>
            </ModelCardContextProvider>
          </ProfileSection>
        ))}
    </div>
  );
};
