import type { ReminderJSON } from '../types/repository.js';
import { verifyReminderEffect } from './write-effect.js';

const native = (change: Partial<ReminderJSON> = {}): ReminderJSON => ({
  id: 'r',
  title: 'Task',
  list: 'Inbox',
  notes: 'Notes',
  url: null,
  dueDate: '2026-11-14',
  locationTrigger: null,
  priority: 0,
  isCompleted: false,
  ...change,
});

it('checks the requested native title and composed notes rather than trusting matching observations', () => {
  expect(verifyReminderEffect({ id: 'r', newTitle: 'After' }, native())).toBe(
    'mismatch',
  );
  expect(
    verifyReminderEffect({ id: 'r', notes: 'Added subtask' }, native()),
  ).toBe('mismatch');
  expect(
    verifyReminderEffect(
      { id: 'r', newTitle: 'Task', notes: 'Notes', priority: 0 },
      native(),
    ),
  ).toBe('matched');
});

it('compares date meaning while preserving all-day versus timed semantics', () => {
  expect(
    verifyReminderEffect({ id: 'r', dueDate: '2026-11-14' }, native()),
  ).toBe('matched');
  expect(
    verifyReminderEffect({ id: 'r', dueDate: '2026-11-14 00:00:00' }, native()),
  ).toBe('mismatch');
  expect(
    verifyReminderEffect(
      { id: 'r', dueDate: '2026-11-14T10:00:00Z' },
      native({ dueDate: '2026-11-14T11:00:00+01:00' }),
    ),
  ).toBe('matched');
  expect(
    verifyReminderEffect({ id: 'r', dueDate: '2026-11-15' }, native()),
  ).toBe('mismatch');
});

it('checks exposed recurrence and leaves unreadable ReminderKit settings unverified', () => {
  const input = { id: 'r', recurrence: { frequency: 'daily' as const } };
  expect(verifyReminderEffect(input, native())).toBe('mismatch');
  expect(
    verifyReminderEffect(
      input,
      native({ recurrenceRules: [{ frequency: 'daily', interval: 1 }] }),
    ),
  ).toBe('matched');
  expect(verifyReminderEffect({ id: 'r', urgent: true }, native())).toBe(
    'unavailable',
  );
  expect(
    verifyReminderEffect({ id: 'r', earlyReminderMinutes: null }, native()),
  ).toBe('unavailable');
});
