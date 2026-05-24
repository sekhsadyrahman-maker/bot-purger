import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import type { FormField } from '@devvit/shared-types/shared/form.js';
import { reddit } from '@devvit/web/server';
import { isT1, isT3 } from '@devvit/shared-types/tid.js';

export const menu = new Hono();

/** Finds the author of the comment or post the moderator clicked on. */
async function resolveAuthor(targetId: string): Promise<string | undefined> {
  if (isT1(targetId)) {
    const comment = await reddit.getCommentById(targetId);
    return comment.authorName;
  }
  if (isT3(targetId)) {
    const post = await reddit.getPostById(targetId);
    return post.authorName;
  }
  return undefined;
}

const buildPurgeFields = (username: string): FormField[] => [
  {
    name: 'username',
    label: 'Username to purge',
    type: 'string',
    helpText: 'Auto-filled from the selected item. Only content in this subreddit is removed.',
    required: true,
    defaultValue: username,
  },
  {
    name: 'removeComments',
    label: 'Remove their comments',
    type: 'boolean',
    defaultValue: true,
  },
  {
    name: 'removePosts',
    label: 'Remove their posts',
    type: 'boolean',
    defaultValue: true,
  },
  {
    name: 'scoreThreshold',
    label: 'Score protection (optional)',
    type: 'number',
    helpText: 'Skip removing any post whose score is above this number. Leave blank to remove everything.',
  },
];

menu.post('/purge-user', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const username = await resolveAuthor(request.targetId);

  if (!username || username === '[deleted]') {
    return c.json<UiResponse>(
      { showToast: 'Could not determine the author of this item.' },
      200
    );
  }

  return c.json<UiResponse>(
    {
      showForm: {
        name: 'purgeUser',
        form: {
          title: `Purge u/${username}`,
          description:
            'Removes this user’s posts and/or comments in this subreddit. Removals run in the background and can be reversed from the mod queue.',
          fields: buildPurgeFields(username),
          acceptLabel: 'Purge',
          cancelLabel: 'Cancel',
        },
      },
    },
    200
  );
});
