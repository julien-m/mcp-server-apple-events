import { createHash } from 'node:crypto';
import type { ReminderJSON } from '../types/repository.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Serializes an observation with deterministic object-key ordering; array order is preserved. */
export function canonicalObservation(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** Hashes the complete native observation, including identity and modification metadata.
 * This token is an observation, never an EventKit compare-and-set capability.
 */
export function reminderVersion(reminder: ReminderJSON): string {
  return createHash('sha256')
    .update(canonicalObservation(reminder))
    .digest('hex');
}
