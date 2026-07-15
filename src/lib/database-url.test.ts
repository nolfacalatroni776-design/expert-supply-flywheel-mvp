import { describe, expect, it } from "vitest";
import { resolveRuntimeDatabaseUrl } from "@/lib/database-url";

describe("resolveRuntimeDatabaseUrl", () => {
  it("uses Neon Prisma URL when the default database is local SQLite", () => {
    expect(
      resolveRuntimeDatabaseUrl({
        DATABASE_URL: "file:./dev.db",
        product_POSTGRES_PRISMA_URL: "postgresql://user:pass@host/db?sslmode=require",
      }),
    ).toBe("postgresql://user:pass@host/db?sslmode=require");
  });

  it("keeps an explicit Postgres DATABASE_URL", () => {
    expect(
      resolveRuntimeDatabaseUrl({
        DATABASE_URL: "postgresql://primary/db",
        product_POSTGRES_PRISMA_URL: "postgresql://neon/db",
      }),
    ).toBe("postgresql://primary/db");
  });

  it("falls back to Vercel Neon DATABASE_URL when Prisma URL is absent", () => {
    expect(
      resolveRuntimeDatabaseUrl({
        DATABASE_URL: "",
        product_DATABASE_URL: "postgres://pooled/db",
      }),
    ).toBe("postgres://pooled/db");
  });
});
