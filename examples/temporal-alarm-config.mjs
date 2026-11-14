/** Validates the owned qualification input before connecting to any MCP server.
 * Fixture identifiers and mutation actions cannot be supplied through config.
 */
export function validateQualificationConfig(config) {
  const reminderKeys = new Set(['title', 'note', 'dueDate', 'temporalAlarm']);
  if (
    !config ||
    typeof config !== 'object' ||
    !config.listName ||
    !config.reminder ||
    Object.keys(config.reminder).some((key) => !reminderKeys.has(key)) ||
    typeof config.reminder.title !== 'string' ||
    !config.reminder.title ||
    config.reminder.temporalAlarm?.action !== 'add' ||
    typeof config.reminder.temporalAlarm.at !== 'string' ||
    Object.keys(config.reminder.temporalAlarm).some(
      (key) => key !== 'action' && key !== 'at',
    ) ||
    !Array.isArray(config.writers) ||
    config.writers.length < 2 ||
    config.writers.length > 8 ||
    config.writers.some(
      (writer) =>
        !writer ||
        typeof writer.title !== 'string' ||
        typeof writer.at !== 'string' ||
        Object.keys(writer).some((key) => key !== 'title' && key !== 'at'),
    ) ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1000 ||
    config.timeoutMs > 60_000 ||
    !Number.isFinite(config.minimumLeadMs) ||
    config.minimumLeadMs <= 0
  )
    throw new Error('Invalid reviewed qualification config');
  return config;
}

/** Builds only the authorized creation mask; no caller field can override identity/action. */
export function qualificationCreateArguments(config) {
  validateQualificationConfig(config);
  return {
    action: 'create',
    targetList: config.listName,
    title: config.reminder.title,
    note: config.reminder.note,
    dueDate: config.reminder.dueDate,
    temporalAlarm: { action: 'add', at: config.reminder.temporalAlarm.at },
  };
}
