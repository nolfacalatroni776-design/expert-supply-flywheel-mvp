import { randomUUID } from "node:crypto";

type EnvLike = Record<string, string | undefined>;

const POSTGRES_PROTOCOL = /^postgres(?:ql)?:\/\//i;
const SAFE_SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const VERCEL_POSTGRES_KEYS = [
  "product_POSTGRES_PRISMA_URL",
  "POSTGRES_PRISMA_URL",
  "product_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "product_POSTGRES_URL",
] as const;

export function resolveIntegrationDatabaseUrl(env: EnvLike = process.env) {
  const explicitUrl = normalizeEnvValue(env.AGENT_INTEGRATION_DATABASE_URL);
  const optedInUrl =
    env.ALLOW_INTEGRATION_DATABASE_WRITES === "1"
      ? VERCEL_POSTGRES_KEYS.map((key) => normalizeEnvValue(env[key])).find((value) => POSTGRES_PROTOCOL.test(value)) ?? ""
      : "";
  const databaseUrl = explicitUrl || optedInUrl;

  if (!databaseUrl) {
    throw new Error(
      "Agent integration tests require AGENT_INTEGRATION_DATABASE_URL, or ALLOW_INTEGRATION_DATABASE_WRITES=1 with DATABASE_URL.",
    );
  }
  if (!POSTGRES_PROTOCOL.test(databaseUrl)) {
    throw new Error("Agent integration tests require a PostgreSQL database URL.");
  }

  return databaseUrl;
}

export function buildIsolatedIntegrationDatabaseUrl(databaseUrl: string, schemaName: string) {
  if (!POSTGRES_PROTOCOL.test(databaseUrl)) {
    throw new Error("Agent integration tests require a PostgreSQL database URL.");
  }
  if (!SAFE_SCHEMA_NAME.test(schemaName)) {
    throw new Error("Invalid integration-test schema name.");
  }

  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schemaName);
  return url.toString();
}

export function createIntegrationSchemaName(label = "agent") {
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  const timestamp = Date.now().toString(36);
  const nonce = randomUUID().replace(/-/g, "").slice(0, 10);
  return `agent_it_${safeLabel || "runtime"}_${timestamp}_${nonce}`.slice(0, 63).replace(/_+$/g, "");
}

function normalizeEnvValue(value: string | undefined) {
  if (!value) return "";
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  return normalized === "undefined" || normalized === "null" ? "" : normalized;
}
