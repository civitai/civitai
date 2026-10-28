import { Alert, Button, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import { useMemo, useRef, useState } from 'react';
import { useSectionMute } from '~/components/CommentsV2/Comment/CreateComment';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditorComponent';
import { StickerPicker } from '~/components/Sticker/StickerPicker';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputRTE, useForm } from '~/libs/form';
import { sectionMuteSchema, upsertCommentv2Schema } from '~/server/schema/commentv2.schema';
import { removeDuplicates } from '~/utils/array-helpers';
import { useCommentSection } from './CommentSectionContext';
import type { CommentV3Comment } from './types';
import { useCommentMutations } from './useCommentMutations';
import classes from '~/components/CommentsV2/Comment/CommentForm.module.scss';

const contentSchema = upsertCommentv2Schema.pick({ content: true });

/**
 * The editor. Writes a new top-level comment, a reply under `parent`, or an edit of `editing`.
 * The toolbar is hidden, so the sticker picker sits in the footer once the editor has focus.
 */
export function CommentEditor({
  parent,
  editing,
  autoFocus,
  onDone,
}: {
  parent?: CommentV3Comment;
  editing?: CommentV3Comment;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const { byId, borderless } = useCommentSection();
  const mutations = useCommentMutations();
  const editorRef = useRef<EditorCommandsRef | null>(null);
  const [focused, setFocused] = useState(!!autoFocus);
  const form = useForm({
    schema: contentSchema,
    defaultValues: { content: editing?.content ?? '' },
    shouldUnregister: false,
    // Not onBlur: pressing Cancel blurs the editor, which flashed "cannot be empty" before it closed.
    mode: 'onSubmit',
  });

  // Mention suggestions: the people already in this conversation.
  const suggestions = useMemo(
    () =>
      removeDuplicates(
        [...byId.values()].flatMap((c) =>
          c.user ? [{ id: c.user.id, label: c.user.username ?? '' }] : []
        ),
        'id'
      ).filter((s) => s.label),
    [byId]
  );

  const close = () => {
    if (!autoFocus) setFocused(false);
    form.reset({ content: editing?.content ?? '' });
    onDone?.();
  };

  const submit = async ({ content }: { content: string }) => {
    try {
      if (editing) await mutations.edit(editing, content);
      else await mutations.create(content, parent ? { id: parent.id, depth: parent.depth } : null);
      form.reset({ content: '' });
      close();
    } catch {
      // The adapter has already shown the error.
    }
  };

  return (
    <Form form={form} onSubmit={submit} className="flex min-w-0 flex-1 flex-col gap-4">
      <InputRTE
        innerRef={editorRef}
        name="content"
        disabled={mutations.saving}
        includeControls={['formatting', 'link', 'mentions', 'sticker']}
        defaultSuggestions={suggestions}
        placeholder={byId.size ? 'Type your comment...' : 'Be the first to leave a comment...'}
        autoFocus={focused}
        onFocus={!autoFocus ? () => setFocused(true) : undefined}
        onSuperEnter={() => form.handleSubmit(submit)()}
        classNames={{
          root: borderless ? 'border-none' : undefined,
          content: clsx(classes.content, 'rounded-3xl'),
        }}
        data-testid="comment-form"
        inputClasses="break-words"
        hideToolbar
      />
      {focused && (
        <div className="flex items-center justify-between gap-4">
          <StickerPicker
            position="top-start"
            onSelect={(sticker) => {
              editorRef.current?.insertSticker({ id: sticker.id, slug: sticker.slug });
              void form.trigger('content');
            }}
          />
          <div className="flex items-center gap-2.5">
            <Button variant="default" size="xs" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="xs"
              loading={mutations.saving}
              disabled={!form.formState.isDirty}
            >
              {editing ? 'Save' : 'Comment'}
            </Button>
          </div>
        </div>
      )}
    </Form>
  );
}

/**
 * The top-level composer with the states a reader can be in: signed out, read-only, without
 * permission, locked or muted (the section's mute control stays reachable in both), or writing.
 */
export function CommentComposer() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { entityType, entityId, locked, isMuted, isReadonly, forceLocked } = useCommentSection();
  const target = sectionMuteSchema.safeParse({ entityType, entityId });
  const sectionMute = useSectionMute({
    target: target.success ? target.data : undefined,
    enabled: true,
  });

  if (!currentUser)
    return (
      <Alert>
        <Text size="sm" ta="center">
          You must{' '}
          <Text
            c="blue.4"
            component={Link}
            href={`/login?returnUrl=${router.asPath}`}
            rel="nofollow"
            inline
          >
            sign in
          </Text>{' '}
          to add a comment
        </Text>
      </Alert>
    );
  if (forceLocked)
    return (
      <Alert color="yellow" classNames={{ message: 'text-center' }}>
        You do not have permissions to add comments.
      </Alert>
    );
  if (isReadonly)
    return (
      <Alert color="yellow" icon={<IconLock />} classNames={{ message: 'text-center' }}>
        Civitai is currently in read-only mode
      </Alert>
    );
  if (locked || isMuted)
    return (
      <div className="flex items-center gap-3">
        <Alert
          color="yellow"
          icon={<IconLock />}
          className="flex-1"
          classNames={{ message: 'text-center' }}
        >
          {isMuted
            ? 'You cannot add comments because you have been muted'
            : 'This thread has been locked'}
        </Alert>
        {sectionMute.control}
      </div>
    );

  return (
    <div className="flex items-start gap-3">
      <UserAvatar user={currentUser} size="md" />
      <CommentEditor />
      {sectionMute.control}
    </div>
  );
}
