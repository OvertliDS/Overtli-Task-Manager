import { clampText, compactOneLine } from './text-utils.mjs';

export function deriveFallbackTasks(prompt, options = {}) {
  return planFallbackRoute(prompt, options).tasks;
}

export function planFallbackRoute(prompt, options = {}) {
  const text = combinePromptContext(prompt, options).trim();
  const goal = options.goal || compactOneLine(text || 'Complete the requested Codex task', 180);
  const lower = text.toLowerCase();
  const documentationEdit = /\b(update|edit|rewrite|fix|add|remove|create|implement)\s+(?:the\s+)?(?:readme|docs?|documentation|architecture|guide|manual)\b/.test(lower);
  const planningOnlyLike = (
    /\b(plan|roadmap|proposal|strategy|outline|spec|design doc)\b/.test(lower)
    || /\b(for later|later implementation|future implementation|not for implementation now|not implement(?:ing)? now)\b/.test(lower)
  ) && !documentationEdit && !/\b(complete now|do now|finish now|implement now|fix now|ship now|commit|push|install globally|reinstall globally)\b/.test(lower);
  const implementationLike = !planningOnlyLike
    && /\b(build|create|implement|fix|refactor|change|add|remove|debug|test|ship|repo|code|extension|mcp|hook|plugin|readme|install|reinstall|commit|push|run|wire|update|repair|resolve)\b/.test(lower);
  const researchLike = planningOnlyLike || /\b(research|review|analyze|inspect|compare|summarize|explain|plan)\b/.test(lower);
  const routePoints = extractRoutePoints(text);
  const tasks = [];

  if (researchLike || implementationLike) {
    tasks.push({
      title: 'Capture goal, constraints, and acceptance criteria',
      required: true,
      priority: 10,
      acceptanceCriteria: ['The route reflects the user goal', 'Constraints and non-goals are represented before execution'],
      internalSteps: [
        'Read the full prompt without collapsing distinct requested items',
        'Classify whether listed phases, steps, or issues are current-scope work or planning/documentation work',
        'Record explicit constraints, exclusions, and success checks before execution'
      ]
    });
  }

  if (routePoints.length && (implementationLike || researchLike)) {
    tasks.push(...routePoints.map((point, index) => taskFromRoutePoint(point, {
      index,
      implementationLike,
      planningOnlyLike,
      basePriority: implementationLike ? 20 : 20
    })));
  } else if (implementationLike) {
    tasks.push(
      { title: 'Inspect relevant project context', required: true, priority: 20, acceptanceCriteria: ['Use existing repository guidance before changing files', 'Avoid redundant scans when project memory is fresh'], internalSteps: ['Read applicable local instructions and project state', 'Find affected files, tests, install surfaces, and docs', 'Identify risks before editing'] },
      { title: 'Implement the requested change set', required: true, priority: 30, acceptanceCriteria: ['Changes are complete for the requested scope', 'No placeholder or intentionally incomplete logic is introduced'], internalSteps: ['Break the requested change into concrete affected surfaces', 'Apply coherent source changes', 'Update related consumers, configuration, and docs when their truth changes'] }
    );
  } else if (researchLike) {
    tasks.push(
      { title: 'Inspect authoritative context', required: true, priority: 20, acceptanceCriteria: ['Use available files or authoritative sources as applicable', 'Record evidence for claims that drive decisions'], internalSteps: ['Find the relevant source of truth', 'Verify claims against current evidence', 'Separate confirmed facts from assumptions'] },
      { title: 'Synthesize a structured answer', required: true, priority: 30, acceptanceCriteria: ['Answer is organized around the user goal', 'Open risks or uncertainties are stated clearly'], internalSteps: ['Organize findings around the requested planning or analysis objective', 'Preserve listed phases, steps, issues, and decisions', 'Call out blockers, risks, and next actions'] },
      { title: 'Save checkpoint summary when useful', required: false, priority: 40, acceptanceCriteria: ['Useful context is cached for continuation'], internalSteps: ['Store only durable, high-signal continuation context'] }
    );
  } else {
    tasks.push({
      title: goal,
      required: true,
      priority: 10,
      acceptanceCriteria: ['Complete the user-requested action accurately'],
      internalSteps: ['Understand the requested action', 'Complete the action with evidence', 'Report the outcome clearly']
    });
  }

  if (implementationLike) {
    tasks.push(
      { title: 'Validate behavior and check for regressions', required: true, priority: 80, acceptanceCriteria: ['Run the most relevant available checks', 'Record failures with blocker evidence or passing checks with validation evidence'], internalSteps: ['Run targeted syntax, unit, or smoke checks for changed surfaces', 'Inspect failures before deciding whether they are blockers', 'Review the final diff for accidental scope expansion'] },
      { title: 'Reconcile evidence and prepare final summary', required: true, priority: 90, acceptanceCriteria: ['Route evidence is reconciled', 'Final summary readiness is verified'], internalSteps: ['Reconcile each route segment against evidence', 'Write a concise final summary or checkpoint', 'Verify readiness for the separate finalization lifecycle operation'] }
    );
  }

  return {
    tasks,
    metadata: {
      classification: documentationEdit ? 'documentation_edit' : (planningOnlyLike ? 'planning_only' : (implementationLike ? 'implementation' : (researchLike ? 'review_or_research' : 'simple'))),
      extractedItemCount: routePoints.length,
      omittedItemCount: 0,
      reasons: documentationEdit ? ['documentation-edit action takes implementation precedence'] : (planningOnlyLike ? ['explicit planning-only language without an immediate implementation directive'] : []),
      warnings: [],
      confidence: routePoints.length >= 2 ? 'high' : 'medium'
    }
  };
}

export function combinePromptContext(prompt, options = {}) {
  const sections = [];
  addContextSection(sections, 'Inline prompt', prompt);
  addContextSection(sections, 'Supplemental context', options.context);
  addContextSection(sections, 'Prompt context', options.promptContext);
  addContextSection(sections, 'Attachments', options.attachments);
  addContextSection(sections, 'Screenshot guidance', options.screenshots || options.images);
  return sections.map((section) => `${section.label}:\n${section.text}`).join('\n\n');
}

export function classifyPrompt(prompt, hasActiveRun = false) {
  const text = String(prompt || '').trim().toLowerCase();
  if (!text) return 'empty';
  if (hasActiveRun && /\b(continue|resume|keep going|carry on|next|from checkpoint)\b/.test(text)) return 'continue';
  if (hasActiveRun && /\b(actually|instead|skip|drop|change|also|add|remove|update|steer|focus on|do not|don't)\b/.test(text)) return 'steer';
  if (/\b(continue|resume|from checkpoint)\b/.test(text)) return 'resume';
  if (/\b(build|create|implement|fix|refactor|add|remove|debug|repair|wire|update)\b/.test(text)
    && /\b(code|bug|test|readme|docs?|hook|mcp|plugin|config|install|file|feature)\b/.test(text)) return 'new_route';
  if (text.length < 140 && !/[.;:]|\band\b.*\band\b/.test(text)) return 'simple';
  return 'new_route';
}

function extractRoutePoints(text) {
  const points = [];
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const point = routePointFromLine(line);
    if (point) points.push(point);
  }

  points.push(...extractInlineRoutePoints(text));
  points.push(...extractSequencedActionPoints(text));
  // Do not silently drop requested work.  The manager enforces the durable
  // maximum and can return structured overflow when a caller configures one.
  const unique = filterExplicitExecutionScope(dedupePoints(points), text);
  return unique;
}

function filterExplicitExecutionScope(points, text) {
  // A large pasted plan may deliberately narrow execution to one numbered
  // phase/task. Do not promote the rest of that plan into required work just
  // because it shares the same prompt. Keep the original item when it is the
  // only actionable point so fallback planning can still construct a route.
  const match = /\b(?:only|just)\s+(?:complete|implement|work\s+on|do|handle|fix|finish)?\s*(?:the\s+)?(phase|step|task)\s*([a-z0-9][\w.-]*)\b/i.exec(String(text || ''));
  if (!match) return points;
  const [, kind, identifier] = match;
  // A trailing period in prose ("only complete Phase 2.") is not the
  // numbered route item itself. Require a route-style separator so that prose
  // mention cannot accidentally capture the following Phase 1 line.
  const directItem = new RegExp(`^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?${escapeRegExp(kind)}\\s*${escapeRegExp(identifier)}\\s*[:)\\-]`, 'i');
  const scoped = points.filter((point) => directItem.test(String(point.original || '')));
  return scoped.length ? scoped : points;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function routePointFromLine(line) {
  const isListItem = /^[-*+]\s+(?:\[[ xX-]\]\s+)?/.test(line) || /^\d+[.)]\s+/.test(line);
  const cleaned = line
    .replace(/^[-*+]\s+\[[ xX-]\]\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .trim();
  if (isSectionHeader(cleaned)) return null;
  const match = /^(?:(phase|step|task|issue|problem|bug|fix|req(?:uirement)?|todo)\s*[\w.-]*\s*[:.)-]\s+)(.+)$/i.exec(cleaned);
  if (match) return { label: titleCase(match[1]), text: compactOneLine(match[2], 180), original: line };
  if (/^(?:phase|step|issue|problem|bug|fix|todo)\s+\w+/i.test(cleaned)) return { label: 'Task', text: compactOneLine(cleaned, 180), original: line };
  if (isListItem && looksLikeListItem(cleaned)) return { label: 'Task', text: compactOneLine(cleaned, 180), original: line };
  return null;
}

function extractInlineRoutePoints(text) {
  const points = [];
  const pattern = /\b(phase|step|issue|problem|bug|fix|todo)\s+([\w.-]+)\s*[:.)-]\s*([^.;\n]+(?:[.;]|$))/gi;
  let match;
  while ((match = pattern.exec(text))) {
    points.push({
      label: titleCase(match[1]),
      text: compactOneLine(match[3].replace(/[.;]\s*$/, ''), 180),
      original: match[0].trim()
    });
  }
  return points;
}

function extractSequencedActionPoints(text) {
  const rawParts = [];
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^then\s+(.+)$/i.exec(line);
    if (match) rawParts.push(match[1].replace(/[.;]\s*$/, '').trim());
  }
  const sentencePattern = /(?:^|[.;]\s+)then\s+([^.;\n]+)/gi;
  let match;
  while ((match = sentencePattern.exec(String(text || '')))) {
    rawParts.push(match[1].trim());
  }
  return rawParts
    .filter(looksLikeActionableItem)
    .map((part) => ({ label: 'Task', text: compactOneLine(part, 180), original: part }));
}

function taskFromRoutePoint(point, { index, implementationLike, planningOnlyLike, basePriority }) {
  const title = titleFromPoint(point, { implementationLike, planningOnlyLike });
  const planning = planningOnlyLike || (!implementationLike && /\b(plan|design|document|spec|outline|proposal|roadmap)\b/i.test(point.text));
  return {
    title,
    description: point.original,
    required: true,
    priority: basePriority + index,
    acceptanceCriteria: [
      planning ? 'The requested planning or documentation item is addressed with current evidence' : 'The requested item is implemented or resolved for the current scope',
      'Concrete evidence is recorded before this segment is marked complete'
    ],
    internalSteps: inferInternalSteps(point.text, { planning })
  };
}

function titleFromPoint(point, { implementationLike, planningOnlyLike }) {
  const text = compactOneLine(point.text, 90).replace(/[.!?]\s*$/, '');
  const hasAction = /^(inspect|review|research|plan|document|update|fix|repair|implement|build|create|add|remove|validate|test|commit|push|install|reinstall)\b/i.test(text);
  if (/^git\s+commit\b.*\bpush\b/i.test(text)) return 'Commit and push changes';
  if (planningOnlyLike) return `Plan ${text}`;
  if (hasAction) return sentenceCase(text);
  if (implementationLike) return `Resolve ${text}`;
  return sentenceCase(text);
}

function inferInternalSteps(text, { planning }) {
  const item = compactOneLine(text, 120);
  if (planning) {
    return [
      `Inspect current context for ${item}`,
      `Preserve explicit constraints, ordering, and non-goals for ${item}`,
      `Draft or update the requested plan/documentation for ${item}`,
      `Verify the plan/documentation matches current evidence`
    ];
  }
  return [
    `Inspect current behavior and affected files for ${item}`,
    `Identify explicit, inferred, and discovered work needed for ${item}`,
    `Implement the complete fix or change for ${item}`,
    `Run targeted checks and record evidence for ${item}`
  ];
}

function dedupePoints(points) {
  const seen = new Set();
  const unique = [];
  for (const point of points) {
    const key = point.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

function looksLikeActionableItem(text) {
  const value = String(text || '').trim();
  if (value.length < 6 || value.length > 220) return false;
  if (isSectionHeader(value)) return false;
  return /\b(inspect|review|research|plan|document|update|fix|repair|implement|build|create|add|remove|validate|test|commit|push|install|reinstall|run|wire|debug|resolve|complete|finish|verify|check)\b/i.test(value)
    || /\b(broken|bug|issue|problem|fails?|errors?|missing|dead|blank|stale|incorrect|wrong|not working|does nothing|no response|crashes?|throws?)\b/i.test(value);
}

function looksLikeListItem(text) {
  const value = String(text || '').trim();
  if (value.length < 3 || value.length > 220) return false;
  if (isSectionHeader(value)) return false;
  if (looksLikeActionableItem(value)) return true;
  return (value.match(/[a-z0-9]+/gi) || []).length >= 2;
}

function isSectionHeader(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/^\[[^\]]+\]$/.test(value)) return true;
  if (/^(?:note|constraint|constraints|non-goal|non-goals|example|examples|because|if|when)\b/i.test(value)) return true;
  return /:\s*$/.test(value) && (value.match(/[a-z0-9]+/gi) || []).length <= 6;
}

function addContextSection(sections, label, value) {
  for (const text of flattenContext(value)) {
    if (!text) continue;
    sections.push({ label, text: clampText(text, 4000) });
  }
}

function flattenContext(value) {
  if (value === undefined || value === null || value === false) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value).trim()].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(flattenContext);
  if (typeof value === 'object') {
    const fields = ['text', 'content', 'description', 'summary', 'ocr', 'ocrText', 'transcript', 'caption', 'guidance', 'filename', 'name'];
    const parts = [];
    for (const field of fields) {
      if (value[field] !== undefined) parts.push(...flattenContext(value[field]));
    }
    if (!parts.length) {
      for (const [key, item] of Object.entries(value)) {
        if (['data', 'bytes', 'base64', 'buffer'].includes(key)) continue;
        parts.push(...flattenContext(item));
      }
    }
    return parts;
  }
  return [];
}

function sentenceCase(text) {
  const value = String(text || '').trim();
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : 'Complete requested item';
}

function titleCase(text) {
  return sentenceCase(String(text || '').toLowerCase());
}
