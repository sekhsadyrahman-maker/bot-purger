import { reddit, redis, scheduler } from '@devvit/web/server';
import type { Comment, Post } from '@devvit/web/server';
import { asTid, isT1, isT3 } from '@devvit/shared-types/tid.js';
import type { T1, T3 } from '@devvit/shared-types/tid.js';

/** Must match the scheduler task name declared in devvit.json. */
export const PURGE_JOB_NAME = 'purge-task';

/** How many of the user's items we fetch from Reddit per scheduler run. */
const PAGE_SIZE = 100;
/** How many items we delete per scheduler run, to stay within time limits. */
const CHUNK_SIZE = 25;
/** Gap between background runs. */
const RESCHEDULE_DELAY_MS = 5_000;
/** How long to keep a job's bookkeeping in Redis. */
const STATE_TTL_SECONDS = 60 * 60 * 24;
/** scoreThreshold sentinel meaning "no score protection". */
const NO_THRESHOLD = -1;

/** Data we hand to each scheduled run so it can find its job state. */
export type PurgeJobData = { jobId: string };

export type PurgeOptions = {
  username: string;
  subredditId: string;
  removeComments: boolean;
  removePosts: boolean;
  /** Skip posts whose score is above this value. -1 disables score protection. */
  scoreThreshold: number;
};

const metaKey = (jobId: string): string => `purge:${jobId}`;
const queueKey = (jobId: string): string => `purge:${jobId}:queue`;

const newJobId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Records a new purge job in Redis and schedules its first background run.
 * No Reddit calls happen here, so the moderator's click returns instantly. The
 * scheduler then fetches and deletes the content in chunks.
 */
export async function startPurgeJob(options: PurgeOptions): Promise<string> {
  const jobId = newJobId();

  await redis.hSet(metaKey(jobId), {
    username: options.username,
    subredditId: options.subredditId,
    removeComments: options.removeComments ? '1' : '0',
    removePosts: options.removePosts ? '1' : '0',
    scoreThreshold: options.scoreThreshold.toString(),
    status: 'pending',
    total: '0',
    processed: '0',
    failed: '0',
    cursor: '',
    fetchDone: '0',
    startedAt: Date.now().toString(),
  });
  await redis.expire(metaKey(jobId), STATE_TTL_SECONDS);

  await scheduler.runJob({
    name: PURGE_JOB_NAME,
    data: { jobId },
    runAt: new Date(Date.now() + 1_000),
  });

  return jobId;
}

type FetchPageResult = {
  /** Matching item fullnames found on this page. */
  ids: string[];
  /** Cursor to pass as `after` on the next run. */
  nextCursor: string;
  /** True when there are no more pages to fetch. */
  exhausted: boolean;
};

/**
 * Fetches a single page of the user's history (newest first), starting from the
 * saved cursor, and returns the IDs that should be removed. Reddit's `after`
 * cursor is simply the fullname of the last item seen, so we can resume exactly
 * where the previous run stopped.
 */
async function fetchPage(
  options: PurgeOptions,
  cursor: string
): Promise<FetchPageResult> {
  const listing = reddit.getCommentsAndPostsByUser({
    username: options.username,
    sort: 'new',
    limit: PAGE_SIZE,
    pageSize: PAGE_SIZE,
    ...(cursor ? { after: cursor } : {}),
  });
  const items: (Post | Comment)[] = await listing.all();

  const ids: string[] = [];
  for (const item of items) {
    if (item.subredditId !== options.subredditId) continue;

    const id = item.id as string;
    if (isT1(id)) {
      if (!options.removeComments) continue;
    } else if (isT3(id)) {
      if (!options.removePosts) continue;
      // Score protection: keep high-engagement posts.
      if (
        options.scoreThreshold !== NO_THRESHOLD &&
        item.score > options.scoreThreshold
      ) {
        continue;
      }
    } else {
      continue;
    }
    ids.push(id);
  }

  const last = items[items.length - 1];
  const nextCursor = last ? (last.id as string) : cursor;
  const exhausted = items.length < PAGE_SIZE;

  return { ids, nextCursor, exhausted };
}

/**
 * Runs one slice of a purge job: fetch the next page of the user's content (if
 * any remain) and delete up to CHUNK_SIZE queued items. The cursor and queue
 * live in Redis, so the job reschedules itself and resumes until everything is
 * done — without ever blocking long enough to hit the serverless time limit.
 */
export async function runPurgeChunk(jobId: string): Promise<void> {
  const meta = await redis.hGetAll(metaKey(jobId));
  const username = meta.username;
  if (!username) {
    console.warn(`[bot-purger] No state found for job ${jobId}; skipping.`);
    return;
  }
  if (meta.status === 'done') return;

  const options: PurgeOptions = {
    username,
    subredditId: meta.subredditId ?? '',
    removeComments: meta.removeComments === '1',
    removePosts: meta.removePosts === '1',
    scoreThreshold: meta.scoreThreshold ? Number(meta.scoreThreshold) : NO_THRESHOLD,
  };

  const storedQueue = await redis.get(queueKey(jobId));
  const queue: string[] = storedQueue ? (JSON.parse(storedQueue) as string[]) : [];

  let fetchDone = meta.fetchDone === '1';
  let cursor = meta.cursor ?? '';
  let total = Number(meta.total ?? '0');

  // --- Phase 1: fetch one more page of the user's content, if any remain. ---
  if (!fetchDone) {
    const page = await fetchPage(options, cursor);
    queue.push(...page.ids);
    cursor = page.nextCursor;
    fetchDone = page.exhausted;
    total += page.ids.length;

    await redis.hSet(metaKey(jobId), {
      cursor,
      fetchDone: fetchDone ? '1' : '0',
      total: total.toString(),
      status: 'running',
    });
    await redis.expire(metaKey(jobId), STATE_TTL_SECONDS);
  }

  // --- Phase 2: delete a chunk of the queued items. ---
  const chunk = queue.slice(0, CHUNK_SIZE);
  const remaining = queue.slice(CHUNK_SIZE);

  let removed = 0;
  let failed = 0;
  for (const id of chunk) {
    try {
      await reddit.remove(asTid<T1 | T3>(id), true);
      removed++;
    } catch (err: unknown) {
      failed++;
      console.error(`[bot-purger] Job ${jobId}: failed to remove ${id}:`, err);
    }
  }

  if (removed > 0) await redis.hIncrBy(metaKey(jobId), 'processed', removed);
  if (failed > 0) await redis.hIncrBy(metaKey(jobId), 'failed', failed);

  await redis.set(queueKey(jobId), JSON.stringify(remaining));
  await redis.expire(queueKey(jobId), STATE_TTL_SECONDS);

  // --- Decide whether more work remains. ---
  if (!fetchDone || remaining.length > 0) {
    await scheduler.runJob({
      name: PURGE_JOB_NAME,
      data: { jobId },
      runAt: new Date(Date.now() + RESCHEDULE_DELAY_MS),
    });
    console.log(
      `[bot-purger] Job ${jobId}: removed ${removed} this run, ${remaining.length} queued, ${fetchDone ? 'fetch complete' : 'still fetching'}.`
    );
  } else {
    await redis.hSet(metaKey(jobId), { status: 'done' });
    await redis.expire(metaKey(jobId), STATE_TTL_SECONDS);
    const finalMeta = await redis.hGetAll(metaKey(jobId));
    console.log(
      `[bot-purger] Job ${jobId} complete. Processed ${finalMeta.processed ?? '0'} item(s), ${finalMeta.failed ?? '0'} failure(s).`
    );
  }
}
