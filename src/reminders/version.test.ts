import type { ReminderJSON } from '../types/repository.js';
import { reminderVersion } from './version.js';

it('versions complete native state independently of object key order', () => {
  const native: ReminderJSON = {
    id: 'r',
    title: 'Task',
    isCompleted: false,
    list: 'Inbox',
    notes: null,
    url: null,
    dueDate: null,
    priority: 0,
    locationTrigger: null,
  };
  expect(reminderVersion(native)).toBe(
    reminderVersion(
      Object.fromEntries(
        Object.entries(native).reverse(),
      ) as unknown as ReminderJSON,
    ),
  );
  for (const change of [
    { notes: '' },
    { title: 'Changed' },
    { list: 'Other' },
    { lastModifiedDate: '2026-11-14T10:00:00Z' },
  ]) {
    expect(reminderVersion({ ...native, ...change })).not.toBe(
      reminderVersion(native),
    );
  }
});
