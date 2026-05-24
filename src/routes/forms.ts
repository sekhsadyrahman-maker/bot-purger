import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, reddit } from '@devvit/web/server';
import { startPurgeJob } from '../core/purge';

type PurgeFormValues = {
  username?: string;
  removeComments?: boolean;
  removePosts?: boolean;
  scoreThreshold?: number;
};

/** Sentinel meaning "no score protection" (matches src/core/purge.ts). */
const NO_THRESHOLD = -1;

export const forms = new Hono();

forms.post('/purge-user-submit', async (c) => {
  const values = await c.req.json<PurgeFormValues>();

  const username = (values.username ?? '').trim().replace(/^u\//i, '');
  const removeComments = values.removeComments !== false;
  const removePosts = values.removePosts !== false;
  const scoreThreshold =
    typeof values.scoreThreshold === 'number' && Number.isFinite(values.scoreThreshold)
      ? values.scoreThreshold
      : NO_THRESHOLD;

  if (!username || username === '[deleted]') {
    return c.json<UiResponse>(
      { showToast: 'Could not determine which user to purge.' },
      200
    );
  }
  if (!removeComments && !removePosts) {
    return c.json<UiResponse>(
      { showToast: 'Select at least one of posts or comments to remove.' },
      200
    );
  }

  // Defense-in-depth: the menu is mod-only, but re-check the acting moderator.
  const [user, subreddit] = await Promise.all([
    reddit.getCurrentUser(),
    reddit.getCurrentSubreddit(),
  ]);
  if (!user) {
    return c.json<UiResponse>(
      { showToast: 'Could not verify your account. Please try again.' },
      200
    );
  }
  const perms = await user.getModPermissionsForSubreddit(subreddit.name);
  if (!perms.includes('all') && !perms.includes('posts')) {
    return c.json<UiResponse>(
      { showToast: 'You need the "posts" mod permission to purge a user.' },
      200
    );
  }

  const jobId = await startPurgeJob({
    username,
    subredditId: context.subredditId,
    removeComments,
    removePosts,
    scoreThreshold,
  });

  console.log(
    `[bot-purger] Scheduled purge job ${jobId} for u/${username} in r/${subreddit.name}.`
  );

  return c.json<UiResponse>(
    {
      showToast: `Purging u/${username}'s content in the background. This may take a little while.`,
    },
    200
  );
});
