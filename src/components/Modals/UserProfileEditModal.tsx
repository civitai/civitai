import { Button, Center, Divider, Group, Input, Stack, Text, Title } from '@mantine/core';
import React, { useEffect } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { trpc } from '~/utils/trpc';
import {
  Form,
  InputCheckbox,
  InputInlineSocialLinkInput,
  InputProfileImageUpload,
  InputSimpleImageUpload,
  InputSwitch,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { userProfileUpdateSchema } from '~/server/schema/user-profile.schema';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { IconExclamationMark } from '@tabler/icons-react';
import { constants } from '~/server/common/constants';

const { openModal, Modal } = createContextModal<{ modelId: number; versionId?: number }>({
  name: 'userProfileEditModal',
  withCloseButton: false,
  size: 'xl',
  Element: ({ context }) => {
    const queryUtils = trpc.useContext();
    const currentUser = useCurrentUser();
    const { isLoading, data: user } = trpc.userProfile.get.useQuery(
      {
        username: currentUser ? currentUser.username : '',
      },
      {
        enabled: !!currentUser?.username,
      }
    );

    const form = useForm({
      schema: userProfileUpdateSchema,
      shouldUnregister: false,
    });

    console.log(user);

    useEffect(() => {
      if (user && user?.profile) {
        form.reset({
          ...user.profile,
          // TODO: Fix typing at some point :grimacing:.
          coverImage: user.profile.coverImage as any,
          profileImage: user?.image,
          links: (user?.links ?? []).map((link) => ({
            id: link.id,
            url: link.url,
            type: link.type,
          })),
        });
      }
    }, [user?.profile]);

    const handleClose = () => context.close();
    const handleSubmit = (data) => {
      console.log(data);
    };

    if (!user && !isLoading) {
      return (
        <Stack>
          <AlertWithIcon icon={<IconExclamationMark />} color="red">
            Something went wrong. we could not fetch your user.
          </AlertWithIcon>

          <Center>
            <Button variant="default" onClick={handleClose}>
              Close
            </Button>
          </Center>
        </Stack>
      );
    }

    console.log(form.getValues());

    return (
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <Group position="apart">
            <Text size={24} weight={590}>
              Edit Profile
            </Text>

            <Button radius="xl" size="md" loading={isLoading} type="submit">
              Save Changes
            </Button>
          </Group>
          <Divider />
          <InputProfileImageUpload name="profileImage" label="Edit profile image" />
          <Divider />
          <InputSimpleImageUpload
            name="coverImage"
            label="Edit cover image"
            aspectRatio={constants.profile.coverImageAspectRatio}
            // Im aware ideally this should ideally be 450, but images will look better on a higher res here
            previewWidth={constants.profile.coverImageWidth}
          >
            <Text size="sm" color="dimmed">
              Suggested resolution: {constants.profile.coverImageWidth}px x{' '}
              {constants.profile.coverImageHeight}px
            </Text>
          </InputSimpleImageUpload>
          <Divider />
          <InputTextArea name="message" label="Message" maxLength={200} />
          <Divider />
          <InputTextArea name="bio" label="Bio" maxLength={400} />
          <Divider />
          <InputText name="location" label="Location" maxLength={400} />
          <Divider />
          <Input.Wrapper label="Privacy">
            <Stack spacing="xs" mt="md">
              <InputSwitch label="Show my location" name="privacySettings.showLocation" />
              <InputSwitch label="Show my followers" name="privacySettings.showFollowers" />
              <InputSwitch label="Show whom I follow" name="privacySettings.showFollowing" />
              <InputSwitch label="Show my rating & reviews" name="privacySettings.showRating" />
            </Stack>
          </Input.Wrapper>
          <Divider />
          <InputInlineSocialLinkInput name="links" label="Social Links" />
        </Stack>
      </Form>
    );
  },
});

export const openUserProfileEditModal = openModal;
export default Modal;
