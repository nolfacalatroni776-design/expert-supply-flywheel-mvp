const neonDatabaseUrlKeys = [
  "product_POSTGRES_PRISMA_URL",
  "POSTGRES_PRISMA_URL",
  "product_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "product_POSTGRES_URL",
];

type EnvLike = Record<string, string | undefined>;

export function resolveRuntimeDatabaseUrl(env: EnvLike = process.env) {
  const current = normalizeEnvValue(env.DATABASE_URL);
  const neonUrl = neonDatabaseUrlKeys
    .filter((key) => key !== "DATABASE_URL")
    .map((key) => normalizeEnvValue(env[key]))
    .find(isPostgresUrl);

  if (neonUrl && (!current || current.startsWith("file:"))) {
    return neonUrl;
  }

  return current;
}

export function installRuntimeDatabaseUrl(env: EnvLike = process.env) {
  const resolved = resolveRuntimeDatabaseUrl(env);
  if (resolved) {
    env.DATABASE_URL = resolved;
  }
  return resolved;
}

function normalizeEnvValue(value: string | undefined) {
  if (!value) return "";
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  return trimmed === "undefined" || trimmed === "null" ? "" : trimmed;
}

function isPostgresUrl(value: string) {
  return /^postgres(?:ql)?:\/\//i.test(value);
}
