import type {
  CreateReminderData,
  ReminderJSON,
  UpdateReminderData,
} from '../types/repository.js';
import { parseReminderDueDate } from '../utils/reminderDateParser.js';

export type ReminderWriteVerification = 'matched' | 'mismatch' | 'unavailable';

function sameDate(
  expected: string | undefined,
  actual: string | null | undefined,
): boolean {
  if (expected === undefined) return true;
  if (
    !actual ||
    /^\d{4}-\d{2}-\d{2}$/.test(expected) !== /^\d{4}-\d{2}-\d{2}$/.test(actual)
  )
    return false;
  const expectedDate = parseReminderDueDate(expected);
  const actualDate = parseReminderDueDate(actual);
  return (
    expectedDate !== undefined &&
    actualDate !== undefined &&
    expectedDate.getTime() === actualDate.getTime()
  );
}

/** Checks the exact native values built by the repository against its ACK.
 * Dates preserve all-day/timed semantics and compare parsed instants. Fields
 * absent from the native read model cannot be certified by this verifier.
 */
export function verifyReminderEffect(
  input: CreateReminderData | UpdateReminderData,
  actual: ReminderJSON,
): ReminderWriteVerification {
  const title =
    'title' in input ? input.title : (input as UpdateReminderData).newTitle;
  const expected = {
    title,
    notes: input.notes,
    url: input.url,
    priority: input.priority,
    isCompleted: 'id' in input ? input.isCompleted : false,
    list: 'list' in input ? input.list : undefined,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && actual[key as keyof ReminderJSON] !== value)
      return 'mismatch';
  }
  if (
    !sameDate(input.dueDate, actual.dueDate) ||
    !sameDate(
      'startDate' in input ? input.startDate : undefined,
      actual.startDate,
    )
  )
    return 'mismatch';
  if (input.recurrence === null && (actual.recurrenceRules?.length ?? 0) !== 0)
    return 'mismatch';
  if (input.recurrence) {
    const rules = actual.recurrenceRules;
    const rule = rules?.[0];
    if (
      rules?.length !== 1 ||
      !rule ||
      rule.frequency !== input.recurrence.frequency ||
      rule.interval !== (input.recurrence.interval ?? 1) ||
      (rule.endDate ?? undefined) !== input.recurrence.endDate
    )
      return 'mismatch';
  }
  // These ReminderKit properties are not returned by the vendored CLI's read
  // model. Keep the actual operation and its identity, but report unknown.
  if (input.urgent !== undefined || input.earlyReminderMinutes !== undefined)
    return 'unavailable';
  return 'matched';
}
