import { describe, expect, it } from "vitest";
import {
  buildIsolatedIntegrationDatabaseUrl,
  createIntegrationSchemaName,
  resolveIntegrationDatabaseUrl,
} from "@/lib/integration-database";

describe("resolveIntegrationDatabaseUrl", () => {
  it("uses an explicitly configured Postgres integration database", () => {
    expect(
      resolveIntegrationDatabaseUrl({
        AGENT_INTEGRATION_DATABASE_URL: "postgresql://tester:secret@db.example.test/app?sslmode=require",
      }),
    ).toBe("postgresql://tester:secret@db.example.test/app?sslmode=require");
  });

  it("rejects SQLite because the generated Prisma client targets Postgres", () => {
    expect(() =>
      resolveIntegrationDatabaseUrl({
        AGENT_INTEGRATION_DATABASE_URL: "file:/tmp/agent-runtime.db",
      }),
    ).toThrow("PostgreSQL");
  });

  it("requires an explicit opt-in before using DATABASE_URL", () => {
    expect(() =>
      resolveIntegrationDatabaseUrl({
        DATABASE_URL: "postgresql://tester:secret@db.example.test/app",
      }),
    ).toThrow("AGENT_INTEGRATION_DATABASE_URL");

    expect(
      resolveIntegrationDatabaseUrl({
        DATABASE_URL: "postgresql://tester:secret@db.example.test/app",
        ALLOW_INTEGRATION_DATABASE_WRITES: "1",
      }),
    ).toBe("postgresql://tester:secret@db.example.test/app");
  });

  it("uses the Vercel Neon URL after opt-in even when DATABASE_URL still points to SQLite", () => {
    expect(
      resolveIntegrationDatabaseUrl({
        DATABASE_URL: "file:./dev.db",
        product_POSTGRES_PRISMA_URL: "postgresql://tester:secret@neon.example.test/app?sslmode=require",
        ALLOW_INTEGRATION_DATABASE_WRITES: "1",
      }),
    ).toBe("postgresql://tester:secret@neon.example.test/app?sslmode=require");
  });
});

describe("buildIsolatedIntegrationDatabaseUrl", () => {
  it("keeps Neon connection options and replaces only the Prisma schema", () => {
    expect(
      buildIsolatedIntegrationDatabaseUrl(
        "postgresql://tester:secret@db.example.test/app?sslmode=require&channel_binding=require&schema=public",
        "agent_it_20260715_ab12",
      ),
    ).toBe(
      "postgresql://tester:secret@db.example.test/app?sslmode=require&channel_binding=require&schema=agent_it_20260715_ab12",
    );
  });

  it("rejects unsafe schema identifiers", () => {
    expect(() =>
      buildIsolatedIntegrationDatabaseUrl(
        "postgresql://tester:secret@db.example.test/app",
        "agent_it; DROP SCHEMA public",
      ),
    ).toThrow("schema");
  });
});

describe("createIntegrationSchemaName", () => {
  it("creates a safe, unique Postgres identifier", () => {
    const first = createIntegrationSchemaName("agent-runtime");
    const second = createIntegrationSchemaName("agent-runtime");

    expect(first).toMatch(/^agent_it_[a-z0-9_]+$/);
    expect(second).toMatch(/^agent_it_[a-z0-9_]+$/);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
  });
});
