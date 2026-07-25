import { compactOneLine } from "./text-utils.mjs";
import {
  normalizeSourceContext,
  sourceContextText,
} from "./source-context.mjs";

export function deriveFallbackTasks(prompt, options = {}) {
  return planFallbackRoute(prompt, options).tasks;
}

export function planFallbackRoute(prompt, options = {}) {
  const sourceContext = normalizeSourceContext({
    prompt,
    context: options.context,
    promptContext: options.promptContext,
    attachments: options.attachments,
    screenshots: options.screenshots,
    images: options.images,
  });
  const text = sourceContextText(sourceContext).trim();
  const goal =
    options.goal ||
    compactOneLine(
      sourceContext.entries[0]?.text || "Complete the requested Codex task",
      180,
    );
  const lower = text.toLowerCase();
  const documentationEdit =
    /\b(update|edit|rewrite|fix|add|remove|create|implement)\s+(?:the\s+)?(?:readme|docs?|documentation|architecture|guide|manual)\b/.test(
      lower,
    );
  const planningOnlyLike =
    (/\b(plan|roadmap|proposal|strategy|outline|spec|design doc)\b/.test(
      lower,
    ) ||
      /\b(for later|later implementation|future implementation|not for implementation now|not implement(?:ing)? now)\b/.test(
        lower,
      )) &&
    !documentationEdit &&
    !/\b(complete now|do now|finish now|implement now|fix now|ship now|commit|push|install globally|reinstall globally)\b/.test(
      lower,
    );
  const implementationLike =
    !planningOnlyLike &&
    /\b(build|create|implement|fix|refactor|change|add|remove|debug|test|ship|repo|code|extension|mcp|hook|plugin|readme|install|reinstall|commit|push|run|wire|update|repair|resolve)\b/.test(
      lower,
    );
  const researchLike =
    planningOnlyLike ||
    /\b(research|review|analyze|inspect|compare|summarize|explain|plan)\b/.test(
      lower,
    );
  const routeExtraction = extractRoutePoints(text);
  const routePoints = routeExtraction.points;
  const requiresModelReview =
    routePoints.length === 0 ||
    routeExtraction.metadata.needsModelReview === true;
  const scaffoldWorkType = inferWorkType(goal, {
    implementationLike,
    planningOnlyLike,
    researchLike,
  });
  const tasks = routePoints.length
    ? routePoints.map((point, index) =>
        taskFromRoutePoint(point, {
          index,
          implementationLike,
          planningOnlyLike,
          researchLike,
          basePriority: 20,
        }),
      )
    : [
        {
          title: `Model review required — ${compactOneLine(goal, 150)}`,
          description:
            "The deterministic fallback intentionally preserves one visible scaffold. The model must review the complete accumulated contract and replace it with outcome-specific route gates, internal subtasks, and mini-steps.",
          required: true,
          priority: 10,
          workType: scaffoldWorkType,
          workTypeSource: "fallback_inferred",
          acceptanceCriteria: [
            "The model reconciles the complete accumulated source contract before implementation",
            "The replacement route preserves explicit constraints, ordering, and success conditions",
          ],
          internalSteps: inferInternalSteps(goal, {
            planning: planningOnlyLike || researchLike,
          }),
          metadata: {
            decomposition: {
              version: 2,
              source: "fallback_scaffold",
              basis: "no_explicit_route_outline",
              hierarchy: [
                "route_segment_gate",
                "internal_subtask",
                "mini_step",
              ],
              contentOwner: "model",
              internalStepSource: "fallback_scaffold",
              needsModelReview: true,
            },
          },
        },
      ];
  const routeIntent = summarizeRouteIntent(tasks, "fallback_inferred");

  return {
    tasks,
    metadata: {
      classification: documentationEdit
        ? "documentation_edit"
        : planningOnlyLike
          ? "planning_only"
          : implementationLike
            ? "implementation"
            : researchLike
              ? "review_or_research"
              : "simple",
      extractedItemCount: routePoints.length,
      omittedItemCount: 0,
      reasons: documentationEdit
        ? ["documentation-edit action takes implementation precedence"]
        : planningOnlyLike
          ? [
              "explicit planning-only language without an immediate implementation directive",
            ]
          : [],
      warnings: requiresModelReview
        ? [
            "The deterministic fallback route must be reviewed and reconciled by the model before implementation.",
          ]
        : [],
      confidence: routePoints.length >= 2 ? "high" : "medium",
      routeIntent,
      decomposition: {
        ...routeExtraction.metadata,
        needsModelReview: requiresModelReview,
        fallbackScaffold: routePoints.length === 0,
      },
    },
  };
}

export function combinePromptContext(prompt, options = {}) {
  return sourceContextText(
    normalizeSourceContext({
      prompt,
      context: options.context,
      promptContext: options.promptContext,
      attachments: options.attachments,
      screenshots: options.screenshots,
      images: options.images,
    }),
  );
}

export function classifyPrompt(prompt, hasActiveRun = false) {
  const text = String(prompt || "")
    .trim()
    .toLowerCase();
  if (!text) return "empty";
  if (
    hasActiveRun &&
    /\b(continue|resume|keep going|carry on|next|from checkpoint)\b/.test(text)
  )
    return "continue";
  if (
    hasActiveRun &&
    /\b(actually|instead|skip|drop|change|also|add|remove|update|steer|focus on|do not|don't)\b/.test(
      text,
    )
  )
    return "steer";
  if (/\b(continue|resume|from checkpoint)\b/.test(text)) return "resume";
  if (
    /\b(build|create|implement|fix|refactor|add|remove|debug|repair|wire|update)\b/.test(
      text,
    ) &&
    /\b(code|bug|test|readme|docs?|hook|mcp|plugin|config|install|file|feature)\b/.test(
      text,
    )
  )
    return "new_route";
  if (text.length < 140 && !/[.;:]|\band\b.*\band\b/.test(text))
    return "simple";
  return "new_route";
}

function extractRoutePoints(text) {
  const points = [];
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let currentPhaseOutline = null;
  for (const line of lines) {
    if (isMajorUnnumberedHeading(line)) {
      currentPhaseOutline = null;
      continue;
    }
    const parsed = routePointFromLine(line);
    if (!parsed) continue;
    const point = contextualizeOutlinePoint(parsed, currentPhaseOutline);
    points.push(point);
    if (point.kind === "phase" && outlineParts(point.outline).length === 1)
      currentPhaseOutline = point.outline;
  }

  points.push(...extractInlineRoutePoints(text));
  points.push(...extractSequencedActionPoints(text));
  // Do not silently drop requested work.  The manager enforces the durable
  // maximum and can return structured overflow when a caller configures one.
  const unique = filterExplicitExecutionScope(dedupePoints(points), text);
  return organizeRoutePoints(unique);
}

function filterExplicitExecutionScope(points, text) {
  // A large pasted plan may deliberately narrow execution to one numbered
  // phase/task. Do not promote the rest of that plan into required work just
  // because it shares the same prompt. Keep the original item when it is the
  // only actionable point so fallback planning can still construct a route.
  const match =
    /\b(?:only|just)\s+(?:complete|implement|work\s+on|do|handle|fix|finish)?\s*(?:the\s+)?(phase|step|task)\s*([a-z0-9][\w.-]*)\b/i.exec(
      String(text || ""),
    );
  if (!match) return points;
  const [, kind, identifier] = match;
  // A trailing period in prose ("only complete Phase 2.") is not the
  // numbered route item itself. Require a route-style separator so that prose
  // mention cannot accidentally capture the following Phase 1 line.
  const directItem = new RegExp(
    `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?${escapeRegExp(kind)}\\s*${escapeRegExp(identifier)}\\s*[:)\\-]`,
    "i",
  );
  const scoped = points.filter((point) =>
    directItem.test(String(point.original || "")),
  );
  return scoped.length ? scoped : points;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routePointFromLine(line) {
  const markdownCleaned = line.replace(/^#{1,6}\s+/, "").trim();
  const explicitOutline = routePointFromOutline(markdownCleaned, line);
  if (explicitOutline) return explicitOutline;
  const isListItem =
    /^[-*+]\s+(?:\[[ xX-]\]\s+)?/.test(line) || /^\d+[.)]\s+/.test(line);
  const cleaned = line
    .replace(/^[-*+]\s+\[[ xX-]\]\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .trim();
  if (isSectionHeader(cleaned)) return null;
  const match =
    /^(?:(phase|step|task|issue|problem|bug|fix|req(?:uirement)?|todo)\s*([a-z0-9][\w.-]*)?\s*[:.)-]\s+)(.+)$/i.exec(
      cleaned,
    );
  if (match)
    return {
      label: titleCase(match[1]),
      kind: match[1].toLowerCase(),
      outline: normalizeOutline(match[2]),
      text: compactOneLine(match[3], 180),
      original: line,
      source: "explicit_prompt",
    };
  if (/^(?:phase|step|issue|problem|bug|fix|todo)\s+\w+/i.test(cleaned))
    return {
      label: "Task",
      text: compactOneLine(cleaned, 180),
      original: line,
      source: "explicit_prompt",
    };
  if (isListItem && looksLikeListItem(cleaned))
    return {
      label: "Task",
      text: compactOneLine(cleaned, 180),
      original: line,
      source: "explicit_prompt",
    };
  return null;
}

function routePointFromOutline(value, original) {
  const cleaned = String(value || "")
    .replace(/^[-*+]\s+(?:\[[ xX-]\]\s+)?/, "")
    .trim();
  const named =
    /^(phase|step|task|issue|problem|bug|fix|req(?:uirement)?|todo)\s+([a-z0-9]+(?:[.-][a-z0-9]+)*)(?:\s*[:)\-]\s*(.+)|\s+(.+))$/i.exec(
      cleaned,
    );
  if (named) {
    const outline = normalizeOutline(named[2]);
    if (
      ["issue", "problem", "bug", "fix", "todo"].includes(
        named[1].toLowerCase(),
      ) &&
      !/\d/.test(named[2])
    )
      return null;
    const text = compactOneLine(named[3] || named[4], 180).replace(
      /^[—–:)\-]\s*/,
      "",
    );
    if (!outline || !text || isSectionHeader(text)) return null;
    return {
      label: titleCase(named[1]),
      kind: named[1].toLowerCase(),
      outline,
      text,
      original,
      source: "explicit_prompt",
    };
  }

  const namedContainer =
    /^(phase|step|task|req(?:uirement)?)\s+([a-z0-9]+(?:[.-][a-z0-9]+)*)\s*:?\s*$/i.exec(
      cleaned,
    );
  if (namedContainer) {
    const outline = normalizeOutline(namedContainer[2]);
    if (!outline) return null;
    return {
      label: titleCase(namedContainer[1]),
      kind: namedContainer[1].toLowerCase(),
      outline,
      text: `${titleCase(namedContainer[1])} ${outline}`,
      original,
      source: "explicit_prompt",
      headingOnly: true,
    };
  }

  const numeric = /^(\d+(?:\.\d+)*)\s*(?:[):\-]\s+|\.\s+|\s+)(.+)$/i.exec(
    cleaned,
  );
  if (!numeric) return null;
  const outline = normalizeOutline(numeric[1]);
  const text = compactOneLine(numeric[2], 180);
  if (!outline || !text || isSectionHeader(text)) return null;
  return {
    label: "Task",
    kind: "outline",
    outline,
    text,
    original,
    source: "explicit_prompt",
  };
}

function normalizeOutline(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^[.:)\-]+|[.:)\-]+$/g, "")
    .replace(/[.-]+/g, ".")
    .replace(/[^a-z0-9.]+/gi, "")
    .replace(/\.{2,}/g, ".");
  return normalized || null;
}

function organizeRoutePoints(points) {
  const outlined = points.filter((point) => point.outline);
  if (!outlined.length)
    return {
      points,
      metadata: {
        version: 2,
        source: points.length ? "explicit_items" : "generic_fallback",
        strategy: points.length ? "flat_explicit_items" : "generic_route",
        gateCount: points.length,
        segmentCount: points.length,
        internalSubtaskCount: 0,
        miniStepCount: 0,
        outline: [],
        needsModelReview: true,
      },
    };

  const indexed = outlined.map((point, index) => ({
    point,
    index: points.indexOf(point) >= 0 ? points.indexOf(point) : index,
    parts: outlineParts(point.outline),
  }));
  const explicitByOutline = new Map(
    indexed.map((record) => [record.point.outline, record]),
  );
  const gateRecords = new Map();
  const subtaskRecords = new Map();

  for (const record of indexed) {
    const gateOutline = record.parts[0];
    const gateRecord =
      gateRecords.get(gateOutline) ||
      createGateRecord(gateOutline, record, explicitByOutline);
    gateRecord.firstIndex = Math.min(gateRecord.firstIndex, record.index);
    gateRecords.set(gateOutline, gateRecord);

    if (record.parts.length < 2) continue;
    const subtaskOutline = record.parts.slice(0, 2).join(".");
    const subtaskRecord =
      subtaskRecords.get(subtaskOutline) ||
      createSubtaskRecord(
        subtaskOutline,
        gateOutline,
        record,
        explicitByOutline,
      );
    subtaskRecord.firstIndex = Math.min(subtaskRecord.firstIndex, record.index);
    subtaskRecords.set(subtaskOutline, subtaskRecord);
    gateRecord.subtaskOutlines.add(subtaskOutline);

    if (record.parts.length < 3) continue;
    subtaskRecord.miniSteps.push({
      ...record.point,
      role: "mini_step",
      depth: record.parts.length,
      parentOutline: subtaskOutline,
      outlinePath: buildOutlinePath(record.parts),
      required: true,
    });
  }

  const executable = [];
  const emittedGates = new Set();
  for (const [pointIndex, point] of points.entries()) {
    if (!point.outline) {
      executable.push(point);
      continue;
    }
    const gateOutline = outlineParts(point.outline)[0];
    const gateRecord = gateRecords.get(gateOutline);
    if (
      !gateRecord ||
      emittedGates.has(gateOutline) ||
      pointIndex < gateRecord.firstIndex
    )
      continue;
    emittedGates.add(gateOutline);
    executable.push(materializeGatePoint(gateRecord, subtaskRecords));
  }
  for (const gateRecord of [...gateRecords.values()].sort(
    (left, right) => left.firstIndex - right.firstIndex,
  )) {
    if (emittedGates.has(gateRecord.outline)) continue;
    emittedGates.add(gateRecord.outline);
    executable.push(materializeGatePoint(gateRecord, subtaskRecords));
  }

  const outline = [];
  for (const gateRecord of [...gateRecords.values()].sort(
    (left, right) => left.firstIndex - right.firstIndex,
  )) {
    outline.push(outlineRecord(gateRecord.point, "route_gate"));
    for (const subtaskOutline of gateRecord.subtaskOutlines) {
      const subtaskRecord = subtaskRecords.get(subtaskOutline);
      if (!subtaskRecord) continue;
      outline.push(outlineRecord(subtaskRecord.point, "internal_subtask"));
      outline.push(
        ...subtaskRecord.miniSteps.map((point) =>
          outlineRecord(point, "mini_step"),
        ),
      );
    }
  }
  const internalSubtaskCount = subtaskRecords.size;
  const miniStepCount = [...subtaskRecords.values()].reduce(
    (total, record) => total + record.miniSteps.length,
    0,
  );
  return {
    points: executable,
    metadata: {
      version: 2,
      source: "explicit_outline",
      strategy: "route_gate_internal_subtask_mini_step",
      gateCount: gateRecords.size,
      segmentCount: executable.length,
      internalSubtaskCount,
      miniStepCount,
      outline,
      needsModelReview: executable.some(
        (point) =>
          point.needsModelReview ||
          !point.internalSteps?.length ||
          point.internalSteps.some(
            (subtask) =>
              subtask.needsModelReview ||
              (!subtask.atomic && !subtask.miniSteps?.length),
          ),
      ),
    },
  };
}

function createGateRecord(gateOutline, record, explicitByOutline) {
  const explicit = explicitByOutline.get(gateOutline);
  const point =
    explicit?.point ||
    synthesizedOutlinePoint({
      outline: gateOutline,
      kind: record.point.kind === "phase" ? "phase" : "task",
      role: "route_gate",
    });
  return {
    outline: gateOutline,
    point,
    firstIndex: explicit?.index ?? record.index,
    subtaskOutlines: new Set(),
  };
}

function createSubtaskRecord(
  subtaskOutline,
  gateOutline,
  record,
  explicitByOutline,
) {
  const explicit = explicitByOutline.get(subtaskOutline);
  const point =
    explicit?.point ||
    synthesizedOutlinePoint({
      outline: subtaskOutline,
      kind: record.point.kind === "phase" ? "phase" : "step",
      role: "internal_subtask",
    });
  return {
    outline: subtaskOutline,
    gateOutline,
    point,
    firstIndex: explicit?.index ?? record.index,
    miniSteps: [],
  };
}

function synthesizedOutlinePoint({ outline, kind, role }) {
  const label = kind === "phase" ? "Phase" : "Step";
  return {
    label,
    kind,
    outline,
    text: `${label} ${outline}`,
    original: `${label} ${outline}`,
    source: "fallback_synthesized",
    synthesized: true,
    role,
    needsModelReview: true,
  };
}

function materializeGatePoint(gateRecord, subtaskRecords) {
  const gateParts = outlineParts(gateRecord.outline);
  const internalSteps = [...gateRecord.subtaskOutlines]
    .map((outline) => subtaskRecords.get(outline))
    .filter(Boolean)
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((record) => {
      const parts = outlineParts(record.outline);
      const miniSteps = record.miniSteps
        .slice()
        .sort((left, right) =>
          compareOutlinePosition(left.outline, right.outline),
        )
        .map((step) => ({
          ...step,
          role: "mini_step",
          required: step.required !== false,
        }));
      return {
        ...record.point,
        role: "internal_subtask",
        depth: 2,
        parentOutline: gateRecord.outline,
        outlinePath: buildOutlinePath(parts),
        required: true,
        atomic: false,
        miniSteps,
        needsModelReview:
          record.point.needsModelReview === true || miniSteps.length === 0,
      };
    });
  return {
    ...gateRecord.point,
    role: "route_gate",
    depth: 1,
    outlinePath: buildOutlinePath(gateParts),
    path: [gateRecord.point.text],
    internalSteps,
    needsModelReview:
      gateRecord.point.needsModelReview === true ||
      internalSteps.length === 0 ||
      internalSteps.some((subtask) => subtask.needsModelReview),
  };
}

function outlineRecord(point, role) {
  const parts = outlineParts(point.outline);
  return {
    outline: point.outline,
    title: point.text,
    kind: point.kind,
    role,
    depth: parts.length,
    ...(point.parentOutline
      ? { parentOutline: point.parentOutline }
      : parts.length > 1
        ? { parentOutline: parts.slice(0, -1).join(".") }
        : {}),
    outlinePath: point.outlinePath || buildOutlinePath(parts),
    source: point.source || "explicit_prompt",
    needsModelReview: point.needsModelReview === true,
  };
}

function buildOutlinePath(parts) {
  return parts.map((_, index) => parts.slice(0, index + 1).join("."));
}

function compareOutlinePosition(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function outlineParts(outline) {
  return String(outline || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function contextualizeOutlinePoint(point, currentPhaseOutline) {
  if (
    !currentPhaseOutline ||
    !point.outline ||
    point.kind === "phase" ||
    point.outline === currentPhaseOutline ||
    point.outline.startsWith(`${currentPhaseOutline}.`)
  )
    return point;
  const outline = `${currentPhaseOutline}.${point.outline}`;
  return {
    ...point,
    outline,
    contextualParentOutline: currentPhaseOutline,
    source: "explicit_prompt_contextualized",
  };
}

function isMajorUnnumberedHeading(line) {
  const cleaned = String(line || "")
    .replace(/^#{1,6}\s+/, "")
    .trim();
  return (
    cleaned.length >= 3 &&
    cleaned.length <= 100 &&
    /^[A-Z][A-Z0-9 /&+(),.'’_-]+$/.test(cleaned) &&
    !/^PHASE\s+[A-Z0-9]/.test(cleaned)
  );
}

function extractInlineRoutePoints(text) {
  const points = [];
  const pattern =
    /\b(phase|step|issue|problem|bug|fix|todo)\s+([\w.-]+)\s*[:.)-]\s*([^.;\n]+(?:[.;]|$))/gi;
  let match;
  while ((match = pattern.exec(text))) {
    points.push({
      label: titleCase(match[1]),
      kind: match[1].toLowerCase(),
      outline: normalizeOutline(match[2]),
      text: compactOneLine(match[3].replace(/[.;]\s*$/, ""), 180),
      original: match[0].trim(),
      source: "explicit_prompt",
    });
  }
  return points;
}

function extractSequencedActionPoints(text) {
  const rawParts = [];
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = /^then\s+(.+)$/i.exec(line);
    if (match) rawParts.push(match[1].replace(/[.;]\s*$/, "").trim());
  }
  const sentencePattern = /(?:^|[.;]\s+)then\s+([^.;\n]+)/gi;
  let match;
  while ((match = sentencePattern.exec(String(text || "")))) {
    rawParts.push(match[1].trim());
  }
  return rawParts.filter(looksLikeActionableItem).map((part) => ({
    label: "Task",
    text: compactOneLine(part, 180),
    original: part,
    source: "explicit_prompt",
  }));
}

function taskFromRoutePoint(
  point,
  { index, implementationLike, planningOnlyLike, researchLike, basePriority },
) {
  const workType = inferWorkType(point.text, {
    implementationLike,
    planningOnlyLike,
    researchLike,
  });
  const title = titleFromPoint(point, { workType });
  const planning = ["planning", "review", "research", "documentation"].includes(
    workType,
  );
  return {
    title,
    description: point.original,
    ...(point.outline
      ? {
          stableKey: `${point.kind || "task"}-${point.outline
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")}`,
        }
      : {}),
    required: true,
    priority: basePriority + index,
    workType,
    workTypeSource: "fallback_inferred",
    acceptanceCriteria: [
      acceptanceCriterionForWorkType(workType),
      "Concrete evidence is recorded before this segment is marked complete",
    ],
    internalSteps: point.internalSteps?.length
      ? point.internalSteps.map((subtask) => ({
          title: subtask.outline
            ? `${subtask.outline} — ${compactOneLine(subtask.text, 460)}`
            : compactOneLine(subtask.text, 500),
          source: subtask.source || "explicit_prompt",
          kind: "internal_subtask",
          required: subtask.required !== false,
          atomic: subtask.atomic === true,
          needsModelReview: subtask.needsModelReview === true,
          ...(subtask.outline ? { outline: subtask.outline } : {}),
          ...(subtask.parentOutline
            ? { parentOutline: subtask.parentOutline }
            : {}),
          ...(subtask.outlinePath?.length
            ? { outlinePath: subtask.outlinePath }
            : {}),
          miniSteps: (subtask.miniSteps || []).map((miniStep) => ({
            title: miniStep.outline
              ? `${miniStep.outline} — ${compactOneLine(miniStep.text, 460)}`
              : compactOneLine(miniStep.text, 500),
            source: miniStep.source || "explicit_prompt",
            kind: "mini_step",
            required: miniStep.required !== false,
            ...(miniStep.outline ? { outline: miniStep.outline } : {}),
            ...(miniStep.parentOutline
              ? { parentOutline: miniStep.parentOutline }
              : {}),
            ...(miniStep.outlinePath?.length
              ? { outlinePath: miniStep.outlinePath }
              : {}),
          })),
        }))
      : inferInternalSteps(point.text, { planning }),
    metadata: {
      decomposition: {
        version: 2,
        source: point.source || "fallback_inferred",
        basis: point.outline ? "explicit_outline" : "explicit_item",
        hierarchy: ["route_segment_gate", "internal_subtask", "mini_step"],
        contentOwner: "model",
        ...(point.outline ? { outline: point.outline } : {}),
        ...(point.parentOutline ? { parentOutline: point.parentOutline } : {}),
        ...(point.outlinePath?.length
          ? { outlinePath: point.outlinePath }
          : {}),
        ...(point.path?.length ? { path: point.path } : {}),
        depth: point.depth || 0,
        internalStepSource: point.internalSteps?.length
          ? "explicit_or_contextual"
          : "fallback_scaffold",
        needsModelReview:
          point.needsModelReview === true ||
          !point.internalSteps?.length ||
          point.internalSteps.some(
            (subtask) =>
              subtask.needsModelReview ||
              (!subtask.atomic && !subtask.miniSteps?.length),
          ),
      },
    },
  };
}

function titleFromPoint(point, { workType }) {
  const text = compactOneLine(point.text, 90).replace(/[.!?]\s*$/, "");
  const hasAction =
    /^(inspect|review|research|plan|document|update|fix|repair|implement|build|create|add|remove|validate|test|commit|push|install|reinstall)\b/i.test(
      text,
    );
  let title;
  if (/^git\s+commit\b.*\bpush\b/i.test(text))
    title = "Commit and push changes";
  else if (workType === "planning" && !/^plan\b/i.test(text))
    title = `Plan ${text}`;
  else if (hasAction) title = sentenceCase(text);
  else if (workType === "implementation") title = `Resolve ${text}`;
  else title = sentenceCase(text);
  if (!point.outline) return title;
  const prefix =
    point.kind === "phase"
      ? `Phase ${point.outline}`
      : point.kind === "step"
        ? `Step ${point.outline}`
        : point.outline;
  return `${prefix} — ${title}`;
}

function inferWorkType(text, options = {}) {
  const value = String(text || "").toLowerCase();
  // In an explicitly planning-only contract, listed phase names are plan
  // subjects rather than commands to install, validate, or implement them.
  if (options.planningOnlyLike) return "planning";
  const candidates = [];
  const add = (workType, pattern) => {
    if (pattern.test(value) && !candidates.includes(workType))
      candidates.push(workType);
  };
  add(
    "planning",
    /\b(plan|planning|roadmap|proposal|strategy|outline|design doc|specification)\b/,
  );
  add("review", /\b(review|audit|assess|evaluate|critique|inspect)\b/);
  add("research", /\b(research|investigate|compare|analy[sz]e)\b/);
  add(
    "documentation",
    /\b(document|documentation|docs?|readme|guide|manual|release notes?)\b/,
  );
  add(
    "implementation",
    /\b(implement|fix|repair|build|refactor|change|add|remove|debug|wire|code)\b/,
  );
  add(
    "validation",
    /\b(validate|verify|test|tests|testing|lint|typecheck|smoke|regression)\b/,
  );
  add("release", /\b(commit|push|package|publish|release|ship)\b/);
  add(
    "operations",
    /\b(install|reinstall|configure|configuration|migrate|migration|operate|operations)\b/,
  );
  add("deployment", /\b(deploy|deployment|rollout)\b/);

  if (candidates.length > 1) return "mixed";
  if (candidates.length === 1) return candidates[0];
  if (options.planningOnlyLike) return "planning";
  if (options.implementationLike) return "implementation";
  if (options.researchLike) return "review";
  return "custom";
}

function acceptanceCriterionForWorkType(workType) {
  switch (workType) {
    case "planning":
      return "The requested plan is complete, internally consistent, and supported by current evidence";
    case "review":
      return "The requested review records evidence-backed findings, risks, and conclusions without implying unrequested implementation";
    case "research":
      return "The requested research records verified sources, findings, uncertainty, and actionable conclusions";
    case "documentation":
      return "The requested documentation is accurate, complete for its audience, and synchronized with verified behavior";
    case "validation":
      return "The requested checks are executed and their results, failures, and residual gaps are recorded";
    case "release":
      return "The requested release state and artifact or repository evidence are verified";
    case "deployment":
      return "The requested deployment outcome and runtime health are verified";
    case "operations":
      return "The requested operational change and recovery or parity checks are verified";
    case "mixed":
      return "Every distinct intent within this gate is completed using evidence appropriate to that work";
    default:
      return "The requested item is completed for the current scope with outcome-appropriate evidence";
  }
}

function summarizeRouteIntent(tasks, source) {
  const workTypes = [
    ...new Set(
      tasks
        .map((task) => task.workType)
        .filter(Boolean)
        .map(String),
    ),
  ];
  return {
    mode:
      workTypes.length > 1 || workTypes.includes("mixed") ? "mixed" : "single",
    workTypes,
    source,
  };
}

function inferInternalSteps(text, { planning }) {
  const item = compactOneLine(text, 120);
  return [
    {
      title: planning
        ? `Review the accumulated contract and define outcome-specific planning subtasks for ${item}`
        : `Review the accumulated contract and define outcome-specific implementation subtasks for ${item}`,
      source: "fallback_scaffold",
      kind: "decomposition_review",
      required: true,
      atomic: false,
      needsModelReview: true,
      miniSteps: [],
    },
  ];
}

function dedupePoints(points) {
  const seen = new Set();
  const unique = [];
  for (const point of points) {
    const normalizedText = point.text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const key = point.outline
      ? `outline:${String(point.outline).toLowerCase()}`
      : `text:${normalizedText}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

function looksLikeActionableItem(text) {
  const value = String(text || "").trim();
  if (value.length < 6 || value.length > 220) return false;
  if (isSectionHeader(value)) return false;
  return (
    /\b(inspect|review|research|plan|document|update|fix|repair|implement|build|create|add|remove|validate|test|commit|push|install|reinstall|run|wire|debug|resolve|complete|finish|verify|check)\b/i.test(
      value,
    ) ||
    /\b(broken|bug|issue|problem|fails?|errors?|missing|dead|blank|stale|incorrect|wrong|not working|does nothing|no response|crashes?|throws?)\b/i.test(
      value,
    )
  );
}

function looksLikeListItem(text) {
  const value = String(text || "").trim();
  if (value.length < 3 || value.length > 220) return false;
  if (isSectionHeader(value)) return false;
  if (looksLikeActionableItem(value)) return true;
  return (value.match(/[a-z0-9]+/gi) || []).length >= 2;
}

function isSectionHeader(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (/^\[[^\]]+\]$/.test(value)) return true;
  if (
    /^(?:note|constraint|constraints|non-goal|non-goals|example|examples|because|if|when)\b/i.test(
      value,
    )
  )
    return true;
  return /:\s*$/.test(value) && (value.match(/[a-z0-9]+/gi) || []).length <= 6;
}

function sentenceCase(text) {
  const value = String(text || "").trim();
  return value
    ? `${value[0].toUpperCase()}${value.slice(1)}`
    : "Complete requested item";
}

function titleCase(text) {
  return sentenceCase(String(text || "").toLowerCase());
}
