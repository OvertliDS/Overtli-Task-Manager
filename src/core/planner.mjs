import { compactOneLine } from './text-utils.mjs';

export function deriveFallbackTasks(prompt, options = {}) {
  const text = String(prompt || '').trim();
  const goal = options.goal || compactOneLine(text || 'Complete the requested Codex task', 180);
  const lower = text.toLowerCase();
  const implementationLike = /build|create|implement|fix|refactor|change|add|remove|debug|test|ship|repo|code|extension|mcp|hook|plugin|readme|install/.test(lower);
  const researchLike = /research|review|analyze|inspect|compare|summarize|explain|plan/.test(lower);
  const tasks = [];

  if (researchLike || implementationLike) {
    tasks.push({
      title: 'Capture goal, constraints, and acceptance criteria',
      required: true,
      priority: 10,
      acceptanceCriteria: ['The route reflects the user goal', 'Constraints and non-goals are represented before execution']
    });
  }

  if (implementationLike) {
    tasks.push(
      { title: 'Inspect relevant project context', required: true, priority: 20, acceptanceCriteria: ['Use existing repository guidance before changing files', 'Avoid redundant scans when project memory is fresh'] },
      { title: 'Implement the requested change set', required: true, priority: 30, acceptanceCriteria: ['Changes are complete for the requested scope', 'No placeholder or intentionally incomplete logic is introduced'] },
      { title: 'Validate behavior and check for regressions', required: true, priority: 40, acceptanceCriteria: ['Run the most relevant available checks', 'Record failures with blocker evidence or passing checks with validation evidence'] },
      { title: 'Summarize outcome and clear active checklist', required: true, priority: 50, acceptanceCriteria: ['Turn summary is written', 'Active route state is cleared after completion'] }
    );
  } else if (researchLike) {
    tasks.push(
      { title: 'Inspect authoritative context', required: true, priority: 20, acceptanceCriteria: ['Use available files or authoritative sources as applicable', 'Record evidence for claims that drive decisions'] },
      { title: 'Synthesize a structured answer', required: true, priority: 30, acceptanceCriteria: ['Answer is organized around the user goal', 'Open risks or uncertainties are stated clearly'] },
      { title: 'Save checkpoint summary when useful', required: false, priority: 40, acceptanceCriteria: ['Useful context is cached for continuation'] }
    );
  } else {
    tasks.push({
      title: goal,
      required: true,
      priority: 10,
      acceptanceCriteria: ['Complete the user-requested action accurately']
    });
  }

  return tasks;
}

export function classifyPrompt(prompt, hasActiveRun = false) {
  const text = String(prompt || '').trim().toLowerCase();
  if (!text) return 'empty';
  if (hasActiveRun && /(continue|resume|keep going|carry on|next|from checkpoint)/.test(text)) return 'continue';
  if (hasActiveRun && /(actually|instead|skip|drop|change|also|add|remove|update|steer|focus on|do not|don't)/.test(text)) return 'steer';
  if (/(continue|resume|from checkpoint)/.test(text)) return 'resume';
  if (text.length < 140 && !/[.;:]|and.*and/.test(text)) return 'simple';
  return 'new_route';
}
