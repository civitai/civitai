import { Button, Paper, Stack, Title } from '@mantine/core';
import { BuzzPill } from '~/components/Shop/BuzzPill';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Countdown } from '~/components/Countdown/Countdown';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import dayjs from '~/shared/utils/dayjs';
import { getModelUrl } from '~/utils/string-helpers';
import clsx from 'clsx';
import classes from './ModelShopCard.module.scss';
import shopClasses from '~/components/Shop/ShopItem.module.scss';

const IMAGE_CARD_WIDTH = 450;

export function ModelShopCard({
  data,
  price,
}: {
  data: UseQueryModelReturn[number];
  price?: number;
}) {
  const image = data.images[0];
  const deadline = data.earlyAccessDeadline;
  const isEarlyAccess = !!deadline && deadline > new Date();
  // Once there's more than a day left, days alone is enough — the hours/minutes
  // just make the badge noisy.
  const daysLeft = deadline ? dayjs(deadline).diff(dayjs(), 'day') : 0;
  const href = getModelUrl({
    modelId: data.id,
    modelName: data.name,
    modelVersionId: data.version.id,
  });

  return (
    <TwCosmeticWrapper cosmetic={data.cosmetic?.data} className="h-full">
      <Paper className={classes.card}>
        <Stack h="100%" gap="md">
          <div className={classes.cardHeader}>
            {image && (
              <ImageGuard2 image={image} connectId={data.id} connectType="model">
                {(safe) => (
                  <>
                    {/* Early Access + time-left badge, then the mod-only rating
                        badge stacked beneath it, both top-left. */}
                    <div className="absolute left-2 top-2 z-10 flex flex-col items-start gap-1">
                      {isEarlyAccess && (
                        <div className={classes.eaBadge}>
                          <span className={classes.eaLabel}>Early Access</span>
                          <span className={classes.eaTime}>
                            {daysLeft >= 1 ? (
                              `${daysLeft}d`
                            ) : (
                              <Countdown endTime={deadline!} format="short" />
                            )}
                          </span>
                        </div>
                      )}
                      <ImageGuard2.BlurToggle />
                    </div>
                    {safe ? (
                      <EdgeMedia2
                        metadata={image.metadata as MixedObject}
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? data.name}
                        type={image.type}
                        imageId={image.id}
                        width={IMAGE_CARD_WIDTH}
                        className={classes.image}
                        skip={getSkipValue(image)}
                      />
                    ) : (
                      <MediaHash {...image} />
                    )}
                  </>
                )}
              </ImageGuard2>
            )}
          </div>

          <Title order={4} lineClamp={2} lh={1.2}>
            {data.name}
          </Title>

          <Stack mt="auto" gap={4}>
            <Link href={href}>
              <Button
                fullWidth
                radius="sm"
                px={10}
                className={clsx(shopClasses.buyButton, shopClasses.buyButtonSolid)}
                styles={{ label: { width: '100%' } }}
              >
                {isEarlyAccess ? (
                  <span className={shopClasses.buyButtonInner}>
                    <span className={shopClasses.buyButtonLabel}>Purchase Access</span>
                    {price != null && <BuzzPill amount={price} />}
                  </span>
                ) : (
                  'View Model'
                )}
              </Button>
            </Link>
          </Stack>
        </Stack>
      </Paper>
    </TwCosmeticWrapper>
  );
}
