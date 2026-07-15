import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("form hydration guards", () => {
  it("suppresses browser-injected caret style mismatches on user input surfaces", () => {
    const files = [
      "src/components/create-project-form.tsx",
      "src/components/agent-command-form.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} should guard editable fields`).toContain("suppressHydrationWarning");
    }
  });
});
