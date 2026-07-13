import { join } from "node:path";
import { evaluateAgentCase, loadAgentEvalCases } from "../src/lib/agent-production-eval";

const casesDir = join(process.cwd(), "evals", "agent-cases");
const cases = loadAgentEvalCases(casesDir);
const results = cases.map(evaluateAgentCase);
const failed = results.filter((result) => !result.passed);

for (const result of results) {
  const status = result.passed ? "PASS" : "FAIL";
  console.log(`${status} ${result.id} ${result.score}/100 - ${result.title}`);
  for (const check of result.checks) {
    console.log(`  ${check.passed ? "ok" : "no"} ${check.name}: ${check.points}/${check.maxPoints}`);
  }
}

if (failed.length) {
  console.error(`Agent eval failed for ${failed.length} case(s): ${failed.map((result) => result.id).join(", ")}`);
  process.exit(1);
}

console.log(`Agent eval passed for ${results.length} case(s).`);

