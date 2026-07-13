import { Badge, Button, Paper, Stack, Text, Title } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Countdown } from '~/components/Countdown/Countdown';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { numberWithCommas } from '~/utils/number-helpers';
import { getModelUrl } from '~/utils/string-helpers';
import classes from './ModelShopCard.module.scss';

const IMAGE_CARD_WIDTH = 450;

export function ModelShopCard({
  data,
  price,
}: {
  data: UseQueryModelReturn[number];
  price?: number;
}) {
  const image = data.images[0];
  const isEarlyAccess = !!data.earlyAccessDeadline && data.earlyAccessDeadline > new Date();
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
                    <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
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

            {isEarlyAccess && (
              <>
                <Badge className={classes.availability} color="success.5" variant="filled">
                  Early Access
                </Badge>
                <Badge className={classes.countdown} color="dark" variant="filled" px={6}>
                  <Text inherit>
                    <Countdown endTime={data.earlyAccessDeadline!} format="short" /> left
                  </Text>
                </Badge>
              </>
            )}
          </div>

          <Stack gap={4} align="flex-start">
            <UserAvatarSimple {...data.user} />
            <Title order={4} lineClamp={2} lh={1.2}>
              {data.name}
            </Title>
          </Stack>

          <Stack mt="auto" gap={4}>
            <Link href={href}>
              <Button fullWidth radius="xl" leftSection={<IconBolt size={16} />}>
                {isEarlyAccess
                  ? price != null
                    ? `Get Early Access · ${numberWithCommas(price)}`
                    : 'Get Early Access'
                  : 'View Model'}
              </Button>
            </Link>
          </Stack>
        </Stack>
      </Paper>
    </TwCosmeticWrapper>
  );
}
