/** Domain errors shared by input validation, repositories and error presentation. */
export class CliUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUserError';
  }
}

/** A known rejected precondition, raised before any native mutation is started. */
export class CliPreconditionError extends CliUserError {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CliPreconditionError';
  }
}

/** Native save was acknowledged but subsequent processing/readback failed. */
export class CliReminderOutcomeUnknownError extends CliUserError {
  constructor(readonly reminderId: string) {
    super('outcome_unknown');
    this.name = 'CliReminderOutcomeUnknownError';
  }
}
