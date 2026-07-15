import { spawnSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";
import {
  buildIsolatedIntegrationDatabaseUrl,
  createIntegrationSchemaName,
} from "./src/lib/integration-database";

const schemaName = createIntegrationSchemaName("workflow");
const baseDatabaseUrl = resolveWorkflowTestDatabaseUrl();
process.env.DATABASE_URL = buildIsolatedIntegrationDatabaseUrl(baseDatabaseUrl, schemaName);
process.env.WORKFLOW_TEST_SCHEMA = schemaName;

export default defineConfig({
  plugins: [workflow()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.workflow.test.ts"],
    globalSetup: ["./scripts/workflow-test-global-setup.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
  },
});

function resolveWorkflowTestDatabaseUrl() {
  const explicit = process.env.AGENT_INTEGRATION_DATABASE_URL?.trim();
  if (explicit) return explicit;

  const readiness = spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "5432", "-d", "postgres"], {
    encoding: "utf8",
  });
  if (readiness.status !== 0) {
    throw new Error("Workflow integration tests need local PostgreSQL or AGENT_INTEGRATION_DATABASE_URL.");
  }
  const identity = spawnSync("psql", ["-h", "127.0.0.1", "-p", "5432", "-d", "postgres", "-Atc", "select current_user"], {
    encoding: "utf8",
  });
  const username = identity.status === 0 ? identity.stdout.trim() : "";
  if (!username) throw new Error("Unable to resolve the local PostgreSQL user for Workflow tests.");
  return `postgresql://${encodeURIComponent(username)}@127.0.0.1:5432/postgres?sslmode=disable`;
}
