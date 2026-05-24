import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { runPurgeChunk } from '../core/purge';
import type { PurgeJobData } from '../core/purge';

export const schedulerTasks = new Hono();

schedulerTasks.post('/purge-task', async (c) => {
  const request = await c.req.json<TaskRequest<PurgeJobData>>();
  const jobId = request.data?.jobId;

  if (!jobId) {
    console.error('[bot-purger] purge-task ran without a jobId.');
    return c.json<TaskResponse>({}, 200);
  }

  await runPurgeChunk(jobId);
  return c.json<TaskResponse>({}, 200);
});
