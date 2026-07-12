import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["--test", "--experimental-test-coverage"],
  { encoding: "utf8" },
);
const output = `${result.stdout || ""}${result.stderr || ""}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status || 1);

const overall = coverageFor(output, "all files");
const critical = [
  "manager.mjs",
  "json-store.mjs",
  "sqlite-store.mjs",
  "validation.mjs",
];
const failures = [];
if (overall === null || overall < 85)
  failures.push(`overall line coverage ${overall ?? "missing"}% is below 85%`);
for (const file of critical) {
  const coverage = coverageFor(output, file);
  if (coverage === null || coverage < 90)
    failures.push(
      `${file} line coverage ${coverage ?? "missing"}% is below 90%`,
    );
}
if (failures.length) {
  process.stderr.write(
    `Coverage gate failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `Coverage gate passed: overall ${overall}%; critical modules >= 90%.\n`,
);

function coverageFor(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^.*?${escaped}\\s*\\|\\s*([0-9.]+)`, "m").exec(
    output,
  );
  return match ? Number(match[1]) : null;
}
