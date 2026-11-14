import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Reminder } from '../types/index.js';
import { CliUserError } from '../utils/errorHandling.js';
import { coordinateReminderWrite } from './write-coordinator.js';

const observation = (version: string): Reminder => ({
  id: 'parent',
  title: 'Task',
  notes: 'Notes',
  list: 'Inbox',
  priority: 0,
  isCompleted: false,
  version,
});
const success = (version: string): CallToolResult => ({
  content: [],
  structuredContent: {
    records: [{ id: 'parent', version, writeVerification: 'matched' }],
  },
});

describe('reminder write contract', () => {
  const locked = { run: async <T>(fn: () => Promise<T>): Promise<T> => fn() };
  it.each([
    undefined,
    'stale',
  ])('rejects missing or stale version %s before execution', async (expectedVersion) => {
    const execute = jest.fn();
    const read = jest.fn().mockResolvedValue(observation('current'));
    const result = await coordinateReminderWrite(
      'reminders_tasks',
      { action: 'update', id: 'parent', expectedVersion },
      execute,
      { lock: locked, read },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: expectedVersion ? 'revision_conflict' : 'revision_required',
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('compares version inside the exclusive section and verifies readback', async () => {
    let held = false;
    const read = jest.fn().mockImplementation(async () => {
      expect(held).toBe(true);
      return observation(read.mock.calls.length === 1 ? 'before' : 'after');
    });
    const execute = jest.fn().mockImplementation(async () => {
      expect(held).toBe(true);
      return success('after');
    });
    const lock = {
      run: async <T>(fn: () => Promise<T>): Promise<T> => {
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      },
    };
    const result = await coordinateReminderWrite(
      'reminders_tasks',
      { action: 'update', id: 'parent', expectedVersion: 'before' },
      execute,
      { lock, read },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      concurrency: {
        guarantee: 'native_observed_non_atomic',
        observedVersion: 'after',
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('reports a post-write mismatch without retry', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(observation('before'))
      .mockResolvedValueOnce(observation('external'));
    const execute = jest.fn().mockResolvedValue(success('written'));
    const result = await coordinateReminderWrite(
      'reminders_tasks',
      { action: 'update', id: 'parent', expectedVersion: 'before' },
      execute,
      { lock: locked, read },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: 'needs_reconciliation' },
      concurrency: { observedVersion: 'external' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('requires parent version for subtask create and keeps unknown outcomes unknown', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('lost ack'));
    const read = jest.fn().mockResolvedValue(observation('before'));
    const args = {
      action: 'create',
      reminderId: 'parent',
      expectedVersion: 'before',
    };
    const result = await coordinateReminderWrite(
      'reminders_subtasks',
      args,
      execute,
      {
        lock: locked,
        read,
      },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: 'outcome_unknown' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

it('retains native create identity when readback fails, without retrying', async () => {
  const execute = jest.fn().mockResolvedValue(success('written'));
  const result = await coordinateReminderWrite(
    'reminders_tasks',
    { action: 'create' },
    execute,
    {
      lock: { run: async (fn) => fn() },
      read: async () => {
        throw new Error('offline');
      },
    },
  );
  expect(result.structuredContent).toMatchObject({
    records: [{ id: 'parent', version: 'written' }],
    error: { code: 'outcome_unknown' },
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  'missing',
  'permission',
  'present',
])('distinguishes deletion readback %s', async (outcome) => {
  const read = jest.fn().mockResolvedValueOnce(observation('before'));
  if (outcome === 'missing')
    read.mockRejectedValueOnce(
      new CliUserError("Not found: Reminder with ID 'parent' not found"),
    );
  else if (outcome === 'permission')
    read.mockRejectedValueOnce(new Error('permission denied'));
  else read.mockResolvedValueOnce(observation('after'));
  const execute = jest.fn().mockResolvedValue({
    content: [],
    structuredContent: { records: [{ id: 'parent' }] },
  });
  const result = await coordinateReminderWrite(
    'reminders_tasks',
    { action: 'delete', id: 'parent', expectedVersion: 'before' },
    execute,
    { lock: { run: async (fn) => fn() }, read },
  );
  if (outcome === 'missing') {
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      concurrency: { observedDeleted: true },
    });
  } else
    expect(result.structuredContent).toMatchObject({
      error: {
        code:
          outcome === 'permission' ? 'outcome_unknown' : 'needs_reconciliation',
      },
    });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('does not call an unchanged ACK a successful requested write', async () => {
  const unchanged = { ...observation('before'), writeVerification: 'mismatch' };
  const execute = jest.fn().mockResolvedValue({
    content: [],
    structuredContent: { records: [unchanged] },
  });
  const result = await coordinateReminderWrite(
    'reminders_tasks',
    { action: 'update', id: 'parent', expectedVersion: 'before' },
    execute,
    {
      lock: { run: async (fn) => fn() },
      read: async () => observation('before'),
    },
  );
  expect(result.structuredContent).toMatchObject({
    error: { code: 'needs_reconciliation' },
    records: [{ id: 'parent' }],
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('returns exactly one final JSON mirror for a known temporal precondition rejection', async () => {
  const structuredContent = {
    error: { code: 'temporal_alarm_duplicate', outcome: 'not_started' },
  };
  const result = await coordinateReminderWrite(
    'reminders_tasks',
    { action: 'update', id: 'parent', expectedVersion: 'before' },
    async () => ({
      isError: true,
      structuredContent,
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    }),
    {
      lock: { run: async (fn) => fn() },
      read: async () => observation('before'),
    },
  );
  const mirrors = result.content.filter(
    (entry) => entry.type === 'text' && entry.text.startsWith('{'),
  );
  expect(mirrors).toHaveLength(1);
  expect(JSON.parse((mirrors[0] as { text: string }).text)).toEqual(
    result.structuredContent,
  );
});
