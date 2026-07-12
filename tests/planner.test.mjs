import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrompt, deriveFallbackTasks, planFallbackRoute } from '../src/core/planner.mjs';

test('planner preserves explicit phases and attaches auditable internal steps', () => {
  const prompt = `Fully implement these phases now:
Phase 1: Fix prompt route segmentation
Phase 2: Preserve internal task details
Phase 3: Add regression tests
Then git commit and push.
Then reinstall the latest version globally.`;
  const tasks = deriveFallbackTasks(prompt, { goal: 'Improve route planning' });
  const titles = tasks.map((task) => task.title);
  assert.ok(titles.includes('Fix prompt route segmentation'));
  assert.ok(titles.includes('Resolve Preserve internal task details'));
  assert.ok(titles.includes('Add regression tests'));
  assert.ok(titles.includes('Commit and push changes'));
  assert.ok(titles.includes('Reinstall the latest version globally'));
  assert.ok(titles.includes('Validate behavior and check for regressions'));
  assert.ok(titles.includes('Reconcile evidence and prepare final summary'));
  assert.deepEqual(tasks.find((task) => task.title === 'Fix prompt route segmentation').internalSteps, [
    'Inspect current behavior and affected files for Fix prompt route segmentation',
    'Identify explicit, inferred, and discovered work needed for Fix prompt route segmentation',
    'Implement the complete fix or change for Fix prompt route segmentation',
    'Run targeted checks and record evidence for Fix prompt route segmentation'
  ]);
});

test('planner retains plain issue bullets as distinct route work', () => {
  const tasks = deriveFallbackTasks(`Fix these issues:
- login button does nothing
- settings page shows stale status
- export crashes on missing path`);
  const titles = tasks.map((task) => task.title);
  assert.ok(titles.includes('Resolve login button does nothing'));
  assert.ok(titles.includes('Resolve settings page shows stale status'));
  assert.ok(titles.includes('Resolve export crashes on missing path'));
  assert.equal(titles.includes('Implement the requested change set'), false);
});

test('planner separates planning-only, documentation-edit, and short coding requests', () => {
  const planning = deriveFallbackTasks(`Create a phase plan for later implementation:
1. Runtime install lane
2. Model manager UX
3. Diagnostics repair flow`);
  assert.deepEqual(planning.filter((task) => /^Plan /.test(task.title)).map((task) => task.title), [
    'Plan Runtime install lane', 'Plan Model manager UX', 'Plan Diagnostics repair flow'
  ]);
  assert.equal(planning.some((task) => task.title === 'Validate behavior and check for regressions'), false);
  const docs = deriveFallbackTasks('Update README documentation with the verified install and recovery commands.');
  assert.equal(docs.some((task) => /^Plan /i.test(task.title)), false);
  assert.equal(docs.some((task) => /clear active checklist/i.test(task.title)), false);
  assert.equal(docs.at(-1).title, 'Reconcile evidence and prepare final summary');
  assert.equal(classifyPrompt('Fix the login bug'), 'new_route');
  assert.equal(classifyPrompt('Update README docs'), 'new_route');
  assert.equal(classifyPrompt('Thanks'), 'simple');
});

test('planner preserves overflow and excludes constraints/non-goals from required work', () => {
  const prompt = [
    'Implement the release hardening:',
    ...Array.from({ length: 14 }, (_, index) => `- Task ${index + 1}: implement safeguard ${index + 1}`),
    '- Constraints: do not push to a remote',
    '- Non-goal: redesign the UI'
  ].join('\n');
  const tasks = deriveFallbackTasks(prompt);
  assert.equal(tasks.filter((task) => /safeguard \d+/.test(task.title)).length, 14);
  assert.equal(tasks.some((task) => /do not push|redesign the ui/i.test(task.title)), false);
  const plan = planFallbackRoute('Update README documentation and fix the install example.');
  assert.equal(plan.metadata.classification, 'documentation_edit');
  assert.equal(plan.metadata.omittedItemCount, 0);
  assert.ok(Array.isArray(plan.metadata.reasons));
});
