import type { AlarmJSON, ReminderJSON } from '../types/repository.js';
import { CreateReminderSchema } from '../validation/schemas.js';
import {
  alarmInstant,
  plannedTemporalAlarms,
  TemporalAlarmSchema,
  verifyTemporalPreservation,
} from './temporal-alarm.js';

const at = '2030-03-31T01:30:00Z';
const now = Date.parse('2030-01-01T00:00:00Z');
const absolute = (date: string): AlarmJSON => ({
  absoluteDate: date,
  alarmType: 'display',
});
const baseline = (alarms: AlarmJSON[]): ReminderJSON => ({
  id: 'r',
  title: 'Task',
  notes: 'Notes [#tag]',
  list: 'Test',
  isCompleted: false,
  priority: 0,
  dueDate: null,
  url: null,
  locationTrigger: null,
  alarms,
});

it('parses explicit offsets to the same instant without DST correction', () => {
  expect(alarmInstant(at)).toBe(alarmInstant('2030-03-31T03:30:00+02:00'));
  expect(alarmInstant(at)).toBe(alarmInstant('2030-03-31T01:30:00.000Z'));
  for (const invalid of [
    '2030-03-31 02:30:00',
    '2030-02-30T10:00:00Z',
    '2030-01-01T00:00:60Z',
    '2030-01-01T00:00:00.001Z',
    '2030-01-01T00:00:00-00:00',
    '2030-01-01T00:00:00+14:01',
    '2000-01-01T00:00:00Z',
  ])
    expect(() => alarmInstant(invalid)).toThrow();
});

it('validates shape, captures a future policy, and allows clearing a past target', () => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    expect(TemporalAlarmSchema.safeParse({ action: 'add', at }).success).toBe(
      true,
    );
    expect(
      TemporalAlarmSchema.safeParse({
        action: 'add',
        at: '2029-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      TemporalAlarmSchema.safeParse({
        action: 'clear',
        target: '2029-01-01T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      TemporalAlarmSchema.safeParse({ action: 'clear', target: at, at })
        .success,
    ).toBe(false);
    expect(
      CreateReminderSchema.safeParse({
        title: 'Test',
        temporalAlarm: { action: 'clear', target: at },
      }).success,
    ).toBe(false);
  } finally {
    jest.restoreAllMocks();
  }
});

it('adds, replaces and clears one target preserving relative, location and unrelated absolute alarms', () => {
  const preserved = [
    absolute('2029-01-01T00:00:00.123Z'),
    { relativeOffset: -600 },
    {
      locationTrigger: {
        title: 'Place',
        latitude: 1,
        longitude: 2,
        proximity: 'enter' as const,
      },
    },
  ];
  const added = plannedTemporalAlarms(preserved, { action: 'add', at }, now);
  expect(added).toHaveLength(preserved.length + 1);
  const next = '2030-04-01T01:30:00Z';
  const replaced = plannedTemporalAlarms(
    added,
    { action: 'replace', target: at, at: next },
    now,
  );
  const cleared = plannedTemporalAlarms(
    replaced,
    { action: 'clear', target: next },
    now,
  );
  expect(cleared).toEqual(preserved);
  expect(preserved).toHaveLength(3);
});

it('rejects ambiguous, absent, duplicate and newly past alarms before an effect', () => {
  expect(() =>
    plannedTemporalAlarms(
      [absolute(at), absolute(at)],
      { action: 'clear', target: at },
      now,
    ),
  ).toThrow('ambiguous');
  expect(() =>
    plannedTemporalAlarms([], { action: 'clear', target: at }, now),
  ).toThrow('missing');
  expect(() =>
    plannedTemporalAlarms([absolute(at)], { action: 'add', at }, now),
  ).toThrow('duplicate');
  expect(() =>
    plannedTemporalAlarms([], { action: 'add', at }, alarmInstant(at)),
  ).toThrow('past');
});

it('verifies the requested effect and fields outside the explicit mask, ignoring alarm ordering', () => {
  const before = baseline([{ relativeOffset: -900 }]);
  const expected = plannedTemporalAlarms(
    before.alarms ?? [],
    { action: 'add', at },
    now,
  );
  const after = {
    ...before,
    alarms: [...expected].reverse(),
    lastModifiedDate: at,
  };
  expect(
    verifyTemporalPreservation(before, expected, after, { id: before.id }),
  ).toBe(true);
  expect(
    verifyTemporalPreservation(
      before,
      expected,
      { ...after, notes: 'Lost notes' },
      { id: before.id },
    ),
  ).toBe(false);
  expect(
    verifyTemporalPreservation(before, expected, before, { id: before.id }),
  ).toBe(false);
  expect(
    verifyTemporalPreservation(
      before,
      expected,
      { ...after, title: 'Changed' },
      { id: before.id, newTitle: 'Changed' },
    ),
  ).toBe(true);
});

it('rejects a field introduced outside the mask when the native baseline omitted it', () => {
  const before = {
    id: 'r',
    title: 'Task',
    list: 'Test',
    isCompleted: false,
    priority: 0,
    alarms: [],
  } as unknown as ReminderJSON;
  expect(
    verifyTemporalPreservation(
      before,
      [],
      { ...before, dueDate: '2030-01-01 12:00:00' },
      { id: 'r' },
    ),
  ).toBe(false);
});

it('rejects native due/start precision loss rather than silently rounding seconds', () => {
  const future = new Date(
    Math.ceil(Date.now() / 60_000) * 60_000 + 120_000,
  ).toISOString();
  const second = future.replace(':00.000Z', ':23Z');
  expect(
    CreateReminderSchema.safeParse({
      title: 'Synthetic',
      dueDate: second,
      temporalAlarm: { action: 'add', at: future },
    }).success,
  ).toBe(false);
  expect(
    CreateReminderSchema.safeParse({
      title: 'Synthetic',
      dueDate: future,
      temporalAlarm: { action: 'add', at: second },
    }).success,
  ).toBe(true);
});
