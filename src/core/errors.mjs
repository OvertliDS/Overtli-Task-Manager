export class OtmError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'OtmError';
    this.code = options.code || 'OTM_ERROR';
    this.details = options.details || undefined;
  }
}

export function assertCondition(condition, message, code = 'OTM_ASSERTION_FAILED', details = undefined) {
  if (!condition) throw new OtmError(message, { code, details });
}
