import { z } from 'zod/v3';
import { CliPreconditionError } from '../types/cli-errors.js';
import type { TemporalAlarmMutation } from '../types/index.js';
import type {
  AlarmJSON,
  ReminderJSON,
  UpdateReminderData,
} from '../types/repository.js';
import { canonicalObservation } from './version.js';

/** Parses an explicit second-precision RFC3339 instant without local-time or calendar correction.
 * @throws CliPreconditionError for unsupported precision, offset, date or UTC range.
 */
export function alarmInstant(value: string): number {
  const match =
    /^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.000)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || match[7] === '-00:00')
    throw new CliPreconditionError('invalid_temporal_alarm_instant');
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const local = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const date = new Date(local);
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    offsetHours > 14 ||
    offsetMinutes > 59 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  )
    throw new CliPreconditionError('invalid_temporal_alarm_instant');
  const epoch =
    local -
    (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  if (epoch < Date.UTC(2001, 0, 1) || epoch >= Date.UTC(2100, 0, 1))
    throw new CliPreconditionError('invalid_temporal_alarm_range');
  return epoch;
}

const instantSchema = z.string().superRefine((value, ctx) => {
  try {
    alarmInstant(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Use a valid offset-bearing second-precision instant in UTC years 2001–2099.',
    });
  }
});
export const TemporalAlarmSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('add'), at: instantSchema }).strict(),
    z
      .object({
        action: z.literal('replace'),
        target: instantSchema,
        at: instantSchema,
      })
      .strict(),
    z.object({ action: z.literal('clear'), target: instantSchema }).strict(),
  ])
  .superRefine((value, ctx) => {
    if ('at' in value) {
      try {
        if (alarmInstant(value.at) <= Date.now())
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['at'],
            message: 'New temporal alarms must be strictly in the future.',
          });
      } catch {
        /* Shape/date error is already attached above. */
      }
    }
  });

function isTarget(alarm: AlarmJSON, epoch: number): boolean {
  return (
    !alarm.locationTrigger &&
    !!alarm.absoluteDate &&
    Date.parse(alarm.absoluteDate) === epoch
  );
}

/** Computes the intended alarm multiset from a captured observation; never mutates the input.
 * @throws CliPreconditionError for a missing/ambiguous target, collision or past new instant.
 */
export function plannedTemporalAlarms(
  existing: readonly AlarmJSON[],
  change: TemporalAlarmMutation,
  now: number,
): AlarmJSON[] {
  const target = 'target' in change ? alarmInstant(change.target) : undefined;
  const matches =
    target === undefined
      ? []
      : existing.filter((alarm) => isTarget(alarm, target));
  if (target !== undefined && matches.length !== 1)
    throw new CliPreconditionError(
      matches.length
        ? 'temporal_alarm_target_ambiguous'
        : 'temporal_alarm_target_missing',
    );
  const at = 'at' in change ? alarmInstant(change.at) : undefined;
  if (at !== undefined && at <= now)
    throw new CliPreconditionError('temporal_alarm_past');
  const remaining = existing.filter(
    (alarm) => target === undefined || !isTarget(alarm, target),
  );
  if (at !== undefined && remaining.some((alarm) => isTarget(alarm, at)))
    throw new CliPreconditionError('temporal_alarm_duplicate');
  return at === undefined
    ? remaining
    : [
        ...remaining,
        {
          absoluteDate: new Date(at).toISOString().replace('.000Z', 'Z'),
          relativeOffset: null,
          locationTrigger: null,
          alarmType: 'display',
        },
      ];
}

function alarmKey(alarm: AlarmJSON): string {
  return canonicalObservation({
    absoluteDate: alarm.absoluteDate
      ? Number.isFinite(Date.parse(alarm.absoluteDate))
        ? Date.parse(alarm.absoluteDate)
        : alarm.absoluteDate
      : null,
    relativeOffset: alarm.relativeOffset ?? null,
    locationTrigger: alarm.locationTrigger ?? null,
    alarmType: alarm.alarmType ?? null,
  });
}

/** Verifies the targeted alarm effect, all other alarms, and native fields outside the explicit write mask. */
export function verifyTemporalPreservation(
  before: ReminderJSON | undefined,
  expected: readonly AlarmJSON[],
  after: ReminderJSON,
  input: Partial<UpdateReminderData>,
): boolean {
  if (
    JSON.stringify(expected.map(alarmKey).sort()) !==
    JSON.stringify((after.alarms ?? []).map(alarmKey).sort())
  )
    return false;
  if (!before) return true;
  const changed = new Set(['alarms', 'lastModifiedDate']);
  for (const [field, value] of Object.entries({
    title: input.newTitle,
    notes: input.notes,
    url: input.url,
    isCompleted: input.isCompleted,
    startDate: input.startDate,
    dueDate: input.dueDate,
    priority: input.priority,
    recurrenceRules: input.recurrence,
  }))
    if (value !== undefined) changed.add(field);
  if (input.isCompleted !== undefined) changed.add('completionDate');
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].every(
    (field) =>
      changed.has(field) ||
      canonicalObservation(before[field as keyof ReminderJSON]) ===
        canonicalObservation(after[field as keyof ReminderJSON]),
  );
}
