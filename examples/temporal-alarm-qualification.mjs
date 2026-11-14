// Explicit synthetic qualification. Fixture content, time, N and paths come from
// a reviewed config. No delete operation or personal reminder inventory exists.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  qualificationCreateArguments,
  validateQualificationConfig,
} from './temporal-alarm-config.mjs';

const [phase, suppliedConfig, writerIndex] = process.argv.slice(2);
if (!phase || !suppliedConfig)
  throw new Error(
    'Usage: prepare|contend|writer|read|cleanup CONFIG [writer-index]',
  );
const configPath = resolve(suppliedConfig);
const bytes = await readFile(configPath, 'utf8');
const config = validateQualificationConfig(JSON.parse(bytes));
const digest = createHash('sha256').update(bytes).digest('hex');
const statePath = resolve(dirname(configPath), config.statePath);
const receiptPath = resolve(dirname(configPath), config.receiptPath);
let state;
try {
  state = JSON.parse(await readFile(statePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (state && state.configDigest !== digest)
  throw new Error('Config changed; inspect instead of replaying');
const save = async () => {
  await writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${statePath}.tmp`, statePath);
};
const receipt = async (value) =>
  appendFile(
    receiptPath,
    `${JSON.stringify({ observedAt: new Date().toISOString(), ...value })}\n`,
    { mode: 0o600 },
  );
const client = new Client({ name: config.clientName, version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(config.url)));
async function call(name, args) {
  const startedAt = new Date().toISOString();
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: config.timeoutMs,
  });
  if (phase !== 'writer') {
    const logged =
      name === 'reminders_lists' && args.action === 'read'
        ? {
            isError: result.isError,
            ownRecords: result.structuredContent?.records?.filter(
              (record) => record.title === config.listName,
            ),
            totalListCount: result.structuredContent?.records?.length,
          }
        : result;
    await receipt({ startedAt, name, arguments: args, result: logged });
  }
  return result;
}
function accepted(result) {
  if (result.isError)
    throw new Error(
      `Inspect outcome without replay: ${JSON.stringify(result.structuredContent)}`,
    );
  return result.structuredContent?.records?.[0];
}
async function ownReminder() {
  if (!state?.reminderId || !state?.listId)
    throw new Error('No recorded synthetic identity');
  const current = accepted(
    await call('reminders_tasks', { action: 'read', id: state.reminderId }),
  );
  if (
    current.id !== state.reminderId ||
    current.list !== config.listName ||
    ![
      config.reminder.title,
      ...config.writers.map((writer) => writer.title),
    ].includes(current.title)
  )
    throw new Error('Fixture identity changed; stop for review');
  return current;
}
async function runWriter(index) {
  return new Promise((resolveWriter, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'writer', configPath, String(index)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(
      () => child.kill('SIGTERM'),
      config.timeoutMs + 5000,
    );
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(deadline);
      if (code !== 0)
        return resolveWriter({
          writerIndex: index,
          transportUnknown: true,
          code,
          stderr,
        });
      try {
        resolveWriter(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}
try {
  if (phase === 'prepare') {
    if (state)
      throw new Error('Never automatically recreate an existing attempt');
    const catalogue = await client.listTools();
    if (
      !catalogue.tools.find((tool) => tool.name === 'reminders_tasks')
        ?.inputSchema.properties?.temporalAlarm
    )
      throw new Error('Temporal schema not installed');
    const lists = await call('reminders_lists', { action: 'read' });
    accepted(lists);
    if (
      lists.structuredContent?.records?.some(
        (list) => list.title === config.listName,
      )
    )
      throw new Error('List name already exists');
    if (
      Date.parse(config.reminder.temporalAlarm.at) - Date.now() <
      config.minimumLeadMs
    )
      throw new Error('Insufficient reviewed lead time; no creation started');
    state = {
      configDigest: digest,
      phase: 'list_create_pending',
      startedAt: new Date().toISOString(),
    };
    await save();
    const list = await call('reminders_lists', {
      action: 'create',
      name: config.listName,
    });
    state.listResult = list;
    state.listId = list.structuredContent?.records?.[0]?.id;
    await save();
    accepted(list);
    if (!state.listId) throw new Error('List identity missing');
    const checked = await call('reminders_lists', { action: 'read' });
    accepted(checked);
    const matching = checked.structuredContent?.records?.filter(
      (item) => item.title === config.listName,
    );
    if (matching?.length !== 1 || matching[0].id !== state.listId)
      throw new Error('List selection ambiguous');
    state.phase = 'reminder_create_pending';
    await save();
    const result = await call(
      'reminders_tasks',
      qualificationCreateArguments(config),
    );
    state.createResult = result;
    state.reminderId =
      result.structuredContent?.records?.[0]?.id ??
      result.structuredContent?.nativeReceipt?.id;
    await save();
    const created = accepted(result);
    if (!created?.version || !state.reminderId)
      throw new Error('Native identity/version absent');
    state.baseline = await ownReminder();
    state.phase = 'prepared';
    await save();
    console.log(
      JSON.stringify({
        phase: state.phase,
        listId: state.listId,
        reminder: state.baseline,
      }),
    );
  } else if (phase === 'writer') {
    const writer = config.writers[Number(writerIndex)];
    if (!writer || state.phase !== 'contending')
      throw new Error('Writer outside reviewed phase');
    const args = {
      action: 'update',
      id: state.reminderId,
      expectedVersion: state.expectedVersion,
      title: writer.title,
      dueDate: writer.at,
      startDate: writer.at,
      temporalAlarm: { action: 'replace', target: state.target, at: writer.at },
    };
    console.log(
      JSON.stringify({
        writerIndex: Number(writerIndex),
        arguments: args,
        result: await call('reminders_tasks', args),
      }),
    );
  } else if (phase === 'contend') {
    if (state?.phase !== 'prepared')
      throw new Error('Contention is a single non-replayed attempt');
    const current = await ownReminder();
    const matches = (current.alarms ?? []).filter(
      (alarm) =>
        !alarm.locationTrigger &&
        Date.parse(alarm.absoluteDate) ===
          Date.parse(config.reminder.temporalAlarm.at),
    );
    if (matches.length !== 1)
      throw new Error('Created alarm not uniquely observed');
    state.expectedVersion = current.version;
    state.target = matches[0].absoluteDate;
    state.phase = 'contending';
    await save();
    state.outcomes = await Promise.all(
      config.writers.map((_, index) => runWriter(index)),
    );
    state.finalAfterContention = await ownReminder();
    state.phase = 'contention_observed';
    await save();
    for (const outcome of state.outcomes)
      await receipt({
        scope: 'separate-native-MCP-client-process',
        ...outcome,
      });
    const successes = state.outcomes.filter(
      (outcome) => outcome.result && !outcome.result.isError,
    );
    const conflicts = state.outcomes.filter(
      (outcome) =>
        outcome.result?.structuredContent?.error?.code === 'revision_conflict',
    );
    const winner =
      successes.length === 1
        ? config.writers[successes[0].writerIndex]
        : undefined;
    state.scheduledAlarmAt = winner?.at;
    state.contentionPassed =
      !!winner &&
      conflicts.length === config.writers.length - 1 &&
      state.finalAfterContention.title === winner.title &&
      state.finalAfterContention.alarms?.some(
        (alarm) =>
          !alarm.locationTrigger &&
          Date.parse(alarm.absoluteDate) === Date.parse(winner.at),
      );
    await save();
    console.log(
      JSON.stringify({
        passed: state.contentionPassed,
        successes: successes.length,
        conflicts: conflicts.length,
        final: state.finalAfterContention,
      }),
    );
    if (!state.contentionPassed) process.exitCode = 1;
  } else if (phase === 'read') {
    console.log(JSON.stringify(await ownReminder()));
  } else if (phase === 'cleanup') {
    if (!state || state.phase === 'cleaned')
      throw new Error('No pending cleanup');
    const current = await ownReminder();
    const candidates = (current.alarms ?? []).filter(
      (alarm) =>
        !alarm.locationTrigger &&
        alarm.absoluteDate &&
        [
          config.reminder.temporalAlarm.at,
          ...config.writers.map((writer) => writer.at),
        ].some((at) => Date.parse(at) === Date.parse(alarm.absoluteDate)),
    );
    if (candidates.length !== 1)
      throw new Error('Owned alarm target missing/ambiguous; inspect');
    state.preCleanup = current;
    await save();
    const result = await call('reminders_tasks', {
      action: 'update',
      id: state.reminderId,
      expectedVersion: current.version,
      completed: true,
      temporalAlarm: { action: 'clear', target: candidates[0].absoluteDate },
    });
    state.cleanupResult = result;
    await save();
    accepted(result);
    state.final = await ownReminder();
    state.cleanupPassed =
      state.final.isCompleted === true &&
      !(state.final.alarms ?? []).some(
        (alarm) =>
          !alarm.locationTrigger &&
          alarm.absoluteDate &&
          Date.parse(alarm.absoluteDate) > Date.now(),
      );
    state.phase = state.cleanupPassed ? 'cleaned' : 'cleanup_unverified';
    await save();
    console.log(
      JSON.stringify({
        phase: state.phase,
        retainedListId: state.listId,
        retainedReminderId: state.reminderId,
        noFutureTestAlarm: state.cleanupPassed,
        final: state.final,
      }),
    );
    if (!state.cleanupPassed) process.exitCode = 1;
  } else throw new Error('Unknown phase');
} finally {
  await client.close();
}
