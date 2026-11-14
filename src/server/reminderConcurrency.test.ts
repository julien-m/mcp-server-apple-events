import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { coordinateReminderWrite } from '../reminders/write-coordinator.js';
import { ReminderWriteLock } from '../reminders/write-lock.js';
import { handleToolCall } from '../tools/index.js';
import { reminderRepository } from '../utils/reminderRepository.js';

jest.mock('../utils/eventCli.js');
jest.mock('../utils/reminderRepository.js');

it('enforces the version contract through the real router and handler', async () => {
  const before = {
    id: 'reminder',
    title: 'Before',
    list: 'Inbox',
    isCompleted: false,
    priority: 0,
    version: 'before',
  };
  const read = jest.mocked(reminderRepository.findReminderById);
  const update = jest.mocked(reminderRepository.updateReminder);
  read.mockResolvedValue(before);
  update.mockClear();
  const request = { action: 'update' as const, id: before.id, title: 'After' };
  const missing = await handleToolCall(
    'reminders_tasks',
    request,
    async () => true,
  );
  expect(missing.structuredContent).toMatchObject({
    error: { code: 'revision_required' },
  });
  expect(update).not.toHaveBeenCalled();
  const stale = await handleToolCall(
    'reminders_tasks',
    { ...request, expectedVersion: 'stale' },
    async () => true,
  );
  expect(stale.structuredContent).toMatchObject({
    error: { code: 'revision_conflict' },
  });
  expect(update).not.toHaveBeenCalled();
  const after = {
    ...before,
    title: request.title,
    version: 'after',
    notes: null,
    url: null,
    dueDate: null,
    locationTrigger: null,
    writeVerification: 'matched' as const,
  };
  read.mockResolvedValueOnce(before).mockResolvedValueOnce({
    ...before,
    title: request.title,
    version: after.version,
  });
  update.mockResolvedValue(after);
  const result = await handleToolCall(
    'reminders_tasks',
    { ...request, expectedVersion: before.version },
    async () => true,
  );
  expect(result.isError).toBe(false);
  expect(update).toHaveBeenCalledTimes(1);
  const mirrors = result.content.filter(
    (item) => item.type === 'text' && item.text.startsWith('{'),
  );
  expect(mirrors).toHaveLength(1);
  expect(JSON.parse((mirrors[0] as { text: string }).text)).toEqual(
    result.structuredContent,
  );
  expect(result.structuredContent).toMatchObject({
    records: [{ id: before.id, version: after.version }],
    concurrency: { guarantee: 'native_observed_non_atomic' },
  });
});

it('lets only one simultaneous writer use the same observed version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reminder-cas-test-'));
  const lock = new ReminderWriteLock(join(root, 'write.lock'));
  const original = {
    id: 'r',
    version: 'before',
    title: 'Task',
    list: 'Inbox',
    priority: 0,
    isCompleted: false,
  };
  let current = original;
  let writes = 0;
  const requests = Array.from({ length: 4 });
  try {
    const results = await Promise.all(
      requests.map(() =>
        coordinateReminderWrite(
          'reminders_tasks',
          {
            action: 'update',
            id: original.id,
            expectedVersion: original.version,
          },
          async (): Promise<CallToolResult> => {
            writes++;
            current = { ...current, version: `write-${writes}` };
            return {
              content: [],
              structuredContent: {
                records: [{ ...current, writeVerification: 'matched' }],
              },
            };
          },
          { lock, read: async () => current },
        ),
      ),
    );
    expect(writes).toBe(1);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.structuredContent?.error && result.isError,
      ),
    ).toHaveLength(requests.length - 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('binds the version check to the task tool identity despite unrelated extra fields', async () => {
  const read = jest.mocked(reminderRepository.findReminderById);
  const update = jest.mocked(reminderRepository.updateReminder);
  update.mockClear();
  read.mockReset().mockImplementation(async (id) => ({
    id,
    version: `${id}-version`,
    title: 'Task',
    list: 'Inbox',
    priority: 0,
    isCompleted: false,
  }));
  const request = {
    action: 'update' as const,
    id: 'target',
    reminderId: 'unrelated',
    expectedVersion: 'unrelated-version',
    title: 'Changed',
  };
  const result = await handleToolCall(
    'reminders_tasks',
    request,
    async () => true,
  );
  expect(result.structuredContent).toMatchObject({
    error: { code: 'revision_conflict' },
  });
  expect(read).toHaveBeenCalledWith(request.id);
  expect(read).not.toHaveBeenCalledWith(request.reminderId);
  expect(update).not.toHaveBeenCalled();
});
