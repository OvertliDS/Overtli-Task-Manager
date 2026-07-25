import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPrompt,
  deriveFallbackTasks,
  planFallbackRoute,
} from "../src/core/planner.mjs";

test("planner preserves explicit phase gates and flags undecomposed outcomes for model review", () => {
  const prompt = `Fully implement these phases now:
Phase 1: Fix prompt route segmentation
Phase 2: Preserve internal task details
Phase 3: Add regression tests
Then git commit and push.
Then reinstall the latest version globally.`;
  const tasks = deriveFallbackTasks(prompt, { goal: "Improve route planning" });
  const titles = tasks.map((task) => task.title);
  assert.ok(titles.includes("Phase 1 — Fix prompt route segmentation"));
  assert.ok(
    titles.includes("Phase 2 — Resolve Preserve internal task details"),
  );
  assert.ok(titles.includes("Phase 3 — Add regression tests"));
  assert.ok(titles.includes("Commit and push changes"));
  assert.ok(titles.includes("Reinstall the latest version globally"));
  assert.equal(
    titles.includes("Validate behavior and check for regressions"),
    false,
  );
  assert.equal(
    titles.includes("Reconcile evidence and prepare final summary"),
    false,
  );
  const phaseOne = tasks.find(
    (task) => task.metadata?.decomposition?.outline === "1",
  );
  assert.equal(phaseOne.internalSteps.length, 1);
  assert.equal(phaseOne.internalSteps[0].source, "fallback_scaffold");
  assert.equal(phaseOne.internalSteps[0].needsModelReview, true);
  assert.deepEqual(phaseOne.internalSteps[0].miniSteps, []);
  assert.equal(phaseOne.metadata.decomposition.needsModelReview, true);
});

test("planner maps an explicit phase to internal subtasks and nested mini-steps", () => {
  const plan = planFallbackRoute(`Implement this hierarchy:
Phase 3 — Fix TTS
Phase 3.1 — Install the model
Phase 3.1.1 — Download the model
Phase 3.1.2 — Create the model directory
Phase 3.2 — Wire the runtime
Phase 3.2.1 — Configure the provider`);
  const phase = plan.tasks.find(
    (task) => task.metadata?.decomposition?.outline === "3",
  );
  assert.equal(phase.title, "Phase 3 — Fix TTS");
  assert.deepEqual(
    phase.internalSteps.map((step) => step.outline),
    ["3.1", "3.2"],
  );
  assert.deepEqual(
    phase.internalSteps[0].miniSteps.map((step) => step.outline),
    ["3.1.1", "3.1.2"],
  );
  assert.deepEqual(
    phase.internalSteps[1].miniSteps.map((step) => step.outline),
    ["3.2.1"],
  );
  assert.equal(plan.metadata.decomposition.gateCount, 1);
  assert.equal(plan.metadata.decomposition.internalSubtaskCount, 2);
  assert.equal(plan.metadata.decomposition.miniStepCount, 3);
  assert.equal(plan.metadata.decomposition.needsModelReview, false);
});

test("planner contextualizes numbered children beneath a phase and synthesizes missing ancestors visibly", () => {
  const contextual = planFallbackRoute(`Implement:
Phase 3 — Fix TTS
1. Install the model
1.1 Download the model
2. Wire the runtime
2.1 Configure the provider`);
  const phase = contextual.tasks.find(
    (task) => task.metadata?.decomposition?.outline === "3",
  );
  assert.deepEqual(
    phase.internalSteps.map((step) => step.outline),
    ["3.1", "3.2"],
  );
  assert.deepEqual(
    phase.internalSteps.map((step) =>
      step.miniSteps.map((miniStep) => miniStep.outline),
    ),
    [["3.1.1"], ["3.2.1"]],
  );

  const orphan = planFallbackRoute(`Implement:
Phase 3.1 — Install the model
Phase 3.1.1 — Download the model`);
  const synthesized = orphan.tasks.find(
    (task) => task.metadata?.decomposition?.outline === "3",
  );
  assert.equal(
    synthesized.metadata.decomposition.source,
    "fallback_synthesized",
  );
  assert.equal(synthesized.metadata.decomposition.needsModelReview, true);
  assert.equal(orphan.metadata.decomposition.needsModelReview, true);
});

test("planner retains plain issue bullets as distinct route work", () => {
  const tasks = deriveFallbackTasks(`Fix these issues:
- login button does nothing
- settings page shows stale status
- export crashes on missing path`);
  const titles = tasks.map((task) => task.title);
  assert.ok(titles.includes("Resolve login button does nothing"));
  assert.ok(titles.includes("Resolve settings page shows stale status"));
  assert.ok(titles.includes("Resolve export crashes on missing path"));
  assert.equal(titles.includes("Implement the requested change set"), false);
});

test("planner separates planning-only, documentation-edit, and short coding requests", () => {
  const planning =
    deriveFallbackTasks(`Create a phase plan for later implementation:
1. Runtime install lane
2. Model manager UX
3. Diagnostics repair flow`);
  assert.deepEqual(
    planning
      .filter((task) => /\bPlan /.test(task.title))
      .map((task) => task.title),
    [
      "1 — Plan Runtime install lane",
      "2 — Plan Model manager UX",
      "3 — Plan Diagnostics repair flow",
    ],
  );
  assert.equal(
    planning.some(
      (task) => task.title === "Validate behavior and check for regressions",
    ),
    false,
  );
  const docs = deriveFallbackTasks(
    "Update README documentation with the verified install and recovery commands.",
  );
  assert.equal(
    docs.some((task) => /^Plan /i.test(task.title)),
    false,
  );
  assert.equal(
    docs.some((task) => /clear active checklist/i.test(task.title)),
    false,
  );
  assert.equal(
    docs[0].title,
    "Model review required — Update README documentation with the verified install and recovery commands.",
  );
  assert.equal(docs[0].metadata.decomposition.needsModelReview, true);
  assert.equal(classifyPrompt("Fix the login bug"), "new_route");
  assert.equal(classifyPrompt("Update README docs"), "new_route");
  assert.equal(classifyPrompt("Thanks"), "simple");
});

test("planner preserves mixed intent per gate instead of coercing the route", () => {
  const plan = planFallbackRoute(`Complete this mixed request:
- Review authentication risks
- Update README with the verified behavior
- Implement token refresh recovery
- Run token refresh regression tests`);

  assert.deepEqual(
    plan.tasks.map((task) => task.workType),
    ["review", "documentation", "implementation", "validation"],
  );
  assert.deepEqual(plan.metadata.routeIntent, {
    mode: "mixed",
    workTypes: ["review", "documentation", "implementation", "validation"],
    source: "fallback_inferred",
  });
  assert.match(plan.tasks[0].acceptanceCriteria[0], /review records/i);
  assert.doesNotMatch(plan.tasks[0].acceptanceCriteria[0], /implemented/i);
  assert.match(
    plan.tasks[2].acceptanceCriteria[0],
    /completed|requested item/i,
  );
  assert.equal(
    plan.tasks.every((task) => task.workTypeSource === "fallback_inferred"),
    true,
  );
});

test("typed and attached prompt text feed the same hierarchy interpretation path", () => {
  const hierarchy = `Implement:
Phase 4 — Repair voice startup
Phase 4.1 — Install the model
Phase 4.1.1 — Download the selected model
Phase 4.1.2 — Verify the model directory`;
  const typed = planFallbackRoute(hierarchy);
  const attached = planFallbackRoute("", {
    attachments: [{ filename: "route.txt", content: hierarchy }],
  });
  const project = (plan) =>
    plan.tasks.map((task) => ({
      title: task.title,
      outline: task.metadata.decomposition.outline,
      internal: task.internalSteps.map((step) => ({
        title: step.title,
        outline: step.outline,
        mini: step.miniSteps.map((miniStep) => ({
          title: miniStep.title,
          outline: miniStep.outline,
        })),
      })),
    }));
  assert.deepEqual(project(attached), project(typed));
  assert.equal(attached.metadata.decomposition.needsModelReview, false);
});

test("unstructured prompts receive one visible scaffold for model-owned decomposition", () => {
  const plan = planFallbackRoute(
    "Fix the authentication race, preserve session history, verify recovery, and publish the checked release.",
  );
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].internalSteps.length, 1);
  assert.equal(plan.tasks[0].internalSteps[0].source, "fallback_scaffold");
  assert.equal(plan.tasks[0].internalSteps[0].needsModelReview, true);
  assert.deepEqual(plan.tasks[0].internalSteps[0].miniSteps, []);
  assert.equal(plan.metadata.decomposition.needsModelReview, true);
});

test("planner preserves overflow and excludes constraints/non-goals from required work", () => {
  const prompt = [
    "Implement the release hardening:",
    ...Array.from(
      { length: 14 },
      (_, index) => `- Task ${index + 1}: implement safeguard ${index + 1}`,
    ),
    "- Task 1: implement safeguard 1",
    "- Constraints: do not push to a remote",
    "- Non-goal: redesign the UI",
  ].join("\n");
  const tasks = deriveFallbackTasks(prompt);
  assert.equal(
    tasks.filter((task) => /safeguard \d+/.test(task.title)).length,
    14,
  );
  assert.equal(
    tasks.some((task) => /do not push|redesign the ui/i.test(task.title)),
    false,
  );
  const plan = planFallbackRoute(
    "Update README documentation and fix the install example.",
  );
  assert.equal(plan.metadata.classification, "documentation_edit");
  assert.equal(plan.metadata.omittedItemCount, 0);
  assert.ok(Array.isArray(plan.metadata.reasons));
});

test("planner honors an explicit only-phase execution scope inside a larger pasted phase list", () => {
  const plan = planFallbackRoute(
    `
Only complete Phase 2.
Phase 1: Refactor the storage contract.
Phase 2: Repair hook continuation and test it.
Phase 3: Publish the release notes.
`,
    { goal: "Complete only phase 2" },
  );
  const requested = plan.tasks.filter((task) =>
    /Phase|Repair hook continuation|storage contract|release notes/i.test(
      task.title,
    ),
  );
  assert.equal(requested.length, 1);
  assert.match(requested[0].title, /Repair hook continuation/i);
  assert.doesNotMatch(
    JSON.stringify(requested),
    /storage contract|release notes/i,
  );
});
