import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Reminder } from '../types/index.js';
import { CliUserError } from '../utils/errorHandling.js';
import { reminderRepository } from '../utils/reminderRepository.js';
import { ReminderBusyError, ReminderWriteLock } from './write-lock.js';

interface WriteRequest {
  action: string;
  id?: string;
  reminderId?: string;
  expectedVersion?: string;
}
interface WriteDependencies {
  lock: {
    run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  };
  read(id: string): Promise<Reminder>;
}
type WriteErrorCode =
  | 'cancelled'
  | 'revision_required'
  | 'revision_conflict'
  | 'writer_busy'
  | 'observation_unavailable'
  | 'outcome_unknown'
  | 'needs_reconciliation';

const guarantee = 'native_observed_non_atomic';
const defaultDependencies: WriteDependencies = {
  lock: new ReminderWriteLock(),
  read: (id) => reminderRepository.findReminderById(id),
};

function failure(
  code: WriteErrorCode,
  expectedVersion?: string,
  observedVersion?: string,
): CallToolResult {
  const structuredContent = {
    error: { code },
    concurrency: { guarantee, expectedVersion, observedVersion },
  };
  return {
    isError: true,
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  };
}

function mirrorResult(result: CallToolResult): CallToolResult {
  const content = result.content.filter((item) => {
    if (item.type !== 'text') return true;
    try {
      const parsed: unknown = JSON.parse(item.text);
      return (
        !parsed ||
        typeof parsed !== 'object' ||
        !['provenance', 'error', 'nativeReceipt', 'concurrency'].some(
          (key) => key in parsed,
        )
      );
    } catch {
      return true;
    }
  });
  return {
    ...result,
    content: [
      ...content,
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ],
  };
}

function retainReceipt(
  result: CallToolResult | undefined,
  error: CallToolResult,
): CallToolResult {
  if (!result) return error;
  return mirrorResult({
    ...error,
    content: [...result.content, ...error.content],
    structuredContent: {
      ...result.structuredContent,
      ...error.structuredContent,
    },
  });
}

function writtenObservation(
  result: CallToolResult,
): { id: string; version: string; writeVerification?: unknown } | undefined {
  const content = result.structuredContent;
  const record: unknown =
    content?.reminderWrite ??
    (Array.isArray(content?.records) ? content.records[0] : undefined);
  if (
    record &&
    typeof record === 'object' &&
    'id' in record &&
    typeof record.id === 'string' &&
    'version' in record &&
    typeof record.version === 'string'
  )
    return {
      id: record.id,
      version: record.version,
      writeVerification:
        'writeVerification' in record ? record.writeVerification : undefined,
    };
  return undefined;
}

async function verifyDelete(
  id: string,
  deps: WriteDependencies,
): Promise<CallToolResult | undefined> {
  try {
    const current = await deps.read(id);
    return failure('needs_reconciliation', undefined, current.version);
  } catch (error) {
    // Only the exact native not-found outcome proves observed local absence.
    // Permission, transport and parse failures must remain unknown.
    if (
      error instanceof CliUserError &&
      error.message === `Not found: Reminder with ID '${id}' not found`
    )
      return undefined;
    return failure('outcome_unknown');
  }
}

/** Serializes complete reminder mutations, checking expected observations before
 * execution and matching native write/readback versions afterward. Never retries.
 * The shared lock covers cooperating MCP processes, not Reminders.app or iCloud.
 * Callers must authorize the exact immutable request before entering this service.
 */
export async function coordinateReminderWrite(
  toolName: 'reminders_tasks' | 'reminders_subtasks',
  args: WriteRequest,
  execute: () => Promise<CallToolResult>,
  deps: WriteDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const id =
    toolName === 'reminders_subtasks'
      ? args.reminderId
      : args.action !== 'create'
        ? args.id
        : undefined;
  if (id && !args.expectedVersion) return failure('revision_required');
  let attempted = false;
  let mutationResult: CallToolResult | undefined;
  try {
    return await deps.lock.run(async () => {
      if (id) {
        const current = await deps.read(id);
        if (
          current.id !== id ||
          !current.version ||
          current.version !== args.expectedVersion
        )
          return failure(
            'revision_conflict',
            args.expectedVersion,
            current.version,
          );
      }
      if (signal?.aborted) return failure('cancelled');
      attempted = true;
      const result = await execute();
      mutationResult = result;
      if (result.isError) {
        const error = result.structuredContent?.error;
        if (
          error &&
          typeof error === 'object' &&
          'outcome' in error &&
          error.outcome === 'not_started'
        )
          return mirrorResult({
            ...result,
            structuredContent: {
              ...result.structuredContent,
              concurrency: { guarantee, expectedVersion: args.expectedVersion },
            },
          });
        const unknown = failure('outcome_unknown', args.expectedVersion);
        return retainReceipt(result, unknown);
      }
      if (args.action === 'delete' && id && toolName === 'reminders_tasks') {
        const error = await verifyDelete(id, deps);
        if (error) return retainReceipt(result, error);
        return mirrorResult({
          ...result,
          structuredContent: {
            ...result.structuredContent,
            concurrency: { guarantee, observedDeleted: true },
          },
        });
      }
      const written = writtenObservation(result);
      if (!written)
        return retainReceipt(
          result,
          failure('outcome_unknown', args.expectedVersion),
        );
      if (written.writeVerification !== 'matched')
        return retainReceipt(
          result,
          failure(
            written.writeVerification === 'mismatch'
              ? 'needs_reconciliation'
              : 'outcome_unknown',
            args.expectedVersion,
          ),
        );
      if (id && written.id !== id)
        return retainReceipt(
          result,
          failure('needs_reconciliation', args.expectedVersion),
        );
      const observed = await deps.read(written.id);
      if (observed.id !== written.id || observed.version !== written.version)
        return retainReceipt(
          result,
          failure('needs_reconciliation', written.version, observed.version),
        );
      return mirrorResult({
        ...result,
        structuredContent: {
          ...result.structuredContent,
          concurrency: { guarantee, observedVersion: observed.version },
        },
      });
    }, signal);
  } catch (error) {
    if (signal?.aborted && !attempted) return failure('cancelled');
    if (error instanceof ReminderBusyError) return failure('writer_busy');
    return retainReceipt(
      mutationResult,
      failure(
        attempted ? 'outcome_unknown' : 'observation_unavailable',
        args.expectedVersion,
      ),
    );
  }
}

/** Serializes list writes against reminder writes, including list deletion.
 * Lists do not yet expose reminder snapshot versions.
 */
export async function coordinateReminderListWrite(
  execute: () => Promise<CallToolResult>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    return await defaultDependencies.lock.run(execute, signal);
  } catch (error) {
    return failure(
      error instanceof ReminderBusyError ? 'writer_busy' : 'outcome_unknown',
    );
  }
}
