const text = (maxLength = 16_000) => ({ type: 'string', maxLength });
const id = () => ({ type: 'string', minLength: 1, maxLength: 128 });

export const internalStepSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: id(), title: text(500), status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'skipped', 'complete', 'completed'] },
    kind: text(80), source: text(128), updatedAt: text(64), completedAt: text(64), index: { type: 'integer', minimum: 0, maximum: 127 }, advance: { type: 'boolean' }
  }
};
export const internalStepInputSchema = { oneOf: [{ type: 'string', minLength: 1, maxLength: 500 }, internalStepSchema] };

export const evidenceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: text(80), summary: text(), message: text(), files: { type: 'array', maxItems: 128, items: text(4_000) },
    command: text(), exitCode: { type: 'integer', minimum: -255, maximum: 255 }, notes: {}
  }
};

export const taskSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: id(), stableKey: text(256), parentId: id(), title: text(500), description: text(), status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'dropped', 'superseded'] },
    required: { type: 'boolean' }, priority: { type: 'integer', minimum: 0, maximum: 1000 }, sortOrder: { type: 'integer', minimum: 0, maximum: 100_000 }, createdBy: text(128),
    acceptanceCriteria: { type: 'array', maxItems: 128, items: text(2_000) }, dependsOn: { type: 'array', maxItems: 128, items: id() },
    internalSteps: { type: 'array', maxItems: 128, items: internalStepInputSchema }, evidence: { type: 'array', maxItems: 32, items: evidenceSchema },
    category: text(80), kind: text(80), type: text(80), metadata: {}, reopen: { type: 'boolean' }
  },
  required: ['title']
};

export const reconciliationChangeSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['add', 'activate', 'drop', 'supersede', 'reopen'] }, taskId: id(), stableKey: text(256), parentId: id(), title: text(500), description: text(), reason: text(),
    acceptanceCriteria: { type: 'array', maxItems: 128, items: text(2_000) }, required: { type: 'boolean' }, priority: { type: 'integer', minimum: 0, maximum: 1000 }, sortOrder: { type: 'integer', minimum: 0, maximum: 100_000 }, createdBy: text(128),
    dependsOn: { type: 'array', maxItems: 128, items: id() }, internalSteps: { type: 'array', maxItems: 128, items: internalStepInputSchema }, evidence: { type: 'array', maxItems: 32, items: evidenceSchema }, category: text(80), kind: text(80), type: text(80), metadata: {}, reopen: { type: 'boolean' }
  },
  required: ['action']
};

export const taskListSchema = { type: 'array', maxItems: 256, items: taskSchema };
export const boundedContextSchema = { oneOf: [text(), { type: 'array', maxItems: 256, items: {} }, { type: 'object', additionalProperties: true }] };
