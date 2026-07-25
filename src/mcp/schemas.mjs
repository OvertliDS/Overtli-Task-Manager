const text = (maxLength = 16_000) => ({ type: "string", maxLength });
const id = () => ({ type: "string", minLength: 1, maxLength: 128 });

export const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: text(80),
    summary: text(),
    message: text(),
    files: { type: "array", maxItems: 128, items: text(4_000) },
    command: text(),
    exitCode: { type: "integer", minimum: -255, maximum: 255 },
    notes: {},
  },
};

export const miniStepSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: id(),
    title: text(500),
    outcome: text(),
    status: {
      type: "string",
      enum: [
        "pending",
        "active",
        "done",
        "blocked",
        "skipped",
        "complete",
        "completed",
      ],
    },
    required: { type: "boolean" },
    kind: text(80),
    source: text(128),
    outline: text(128),
    parentOutline: text(128),
    outlinePath: {
      type: "array",
      maxItems: 128,
      items: text(500),
    },
    dependsOn: { type: "array", maxItems: 128, items: id() },
    sourceRefs: { type: "array", maxItems: 128, items: text() },
    evidenceRequired: { type: "boolean" },
    acceptanceCriteria: {
      type: "array",
      maxItems: 128,
      items: text(),
    },
    evidence: { type: "array", maxItems: 32, items: evidenceSchema },
    updatedAt: text(64),
    completedAt: text(64),
    index: { type: "integer", minimum: 0, maximum: 127 },
    advance: { type: "boolean" },
  },
};
export const miniStepInputSchema = {
  oneOf: [{ type: "string", minLength: 1, maxLength: 500 }, miniStepSchema],
};

export const internalStepSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: id(),
    title: text(500),
    outcome: text(),
    status: {
      type: "string",
      enum: [
        "pending",
        "active",
        "done",
        "blocked",
        "skipped",
        "complete",
        "completed",
      ],
    },
    required: { type: "boolean" },
    kind: text(80),
    source: text(128),
    outline: text(128),
    parentOutline: text(128),
    outlinePath: {
      type: "array",
      maxItems: 128,
      items: text(500),
    },
    dependsOn: { type: "array", maxItems: 128, items: id() },
    sourceRefs: { type: "array", maxItems: 128, items: text() },
    evidenceRequired: { type: "boolean" },
    atomic: { type: "boolean" },
    atomicRationale: text(),
    needsModelReview: { type: "boolean" },
    acceptanceCriteria: {
      type: "array",
      maxItems: 128,
      items: text(),
    },
    evidence: { type: "array", maxItems: 32, items: evidenceSchema },
    miniSteps: {
      type: "array",
      maxItems: 128,
      items: miniStepInputSchema,
    },
    updatedAt: text(64),
    completedAt: text(64),
    index: { type: "integer", minimum: 0, maximum: 127 },
    advance: { type: "boolean" },
  },
};
export const internalStepInputSchema = {
  oneOf: [{ type: "string", minLength: 1, maxLength: 500 }, internalStepSchema],
};

export const taskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: id(),
    stableKey: text(256),
    parentId: id(),
    title: text(500),
    description: text(),
    outcome: text(),
    status: {
      type: "string",
      enum: ["pending", "active", "done", "blocked", "dropped", "superseded"],
    },
    required: { type: "boolean" },
    priority: { type: "integer", minimum: 0, maximum: 1000 },
    sortOrder: { type: "integer", minimum: 0, maximum: 100_000 },
    createdBy: text(128),
    acceptanceCriteria: { type: "array", maxItems: 128, items: text(2_000) },
    dependsOn: { type: "array", maxItems: 128, items: id() },
    internalSteps: {
      type: "array",
      maxItems: 128,
      items: internalStepInputSchema,
    },
    evidence: { type: "array", maxItems: 32, items: evidenceSchema },
    sourceRefs: { type: "array", maxItems: 128, items: text() },
    evidencePolicy: text(),
    workType: text(80),
    workTypeSource: text(80),
    category: text(80),
    kind: text(80),
    type: text(80),
    metadata: {},
    reopen: { type: "boolean" },
  },
  required: ["title"],
};

export const reconciliationChangeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["add", "activate", "drop", "supersede", "reopen"],
    },
    taskId: id(),
    stableKey: text(256),
    parentId: id(),
    title: text(500),
    description: text(),
    outcome: text(),
    reason: text(),
    acceptanceCriteria: { type: "array", maxItems: 128, items: text(2_000) },
    required: { type: "boolean" },
    priority: { type: "integer", minimum: 0, maximum: 1000 },
    sortOrder: { type: "integer", minimum: 0, maximum: 100_000 },
    createdBy: text(128),
    dependsOn: { type: "array", maxItems: 128, items: id() },
    internalSteps: {
      type: "array",
      maxItems: 128,
      items: internalStepInputSchema,
    },
    evidence: { type: "array", maxItems: 32, items: evidenceSchema },
    sourceRefs: { type: "array", maxItems: 128, items: text() },
    evidencePolicy: text(),
    workType: text(80),
    workTypeSource: text(80),
    category: text(80),
    kind: text(80),
    type: text(80),
    metadata: {},
    reopen: { type: "boolean" },
  },
  required: ["action"],
};

export const taskListSchema = {
  type: "array",
  maxItems: 256,
  items: taskSchema,
};
export const boundedContextSchema = {
  oneOf: [
    text(256 * 1024),
    { type: "array", maxItems: 256, items: {} },
    { type: "object", additionalProperties: true },
  ],
};
