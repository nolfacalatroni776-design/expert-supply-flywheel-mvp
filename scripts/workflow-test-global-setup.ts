import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export default async function setup() {
  const databaseUrl = process.env.DATABASE_URL;
  const schemaName = process.env.WORKFLOW_TEST_SCHEMA;
  if (!databaseUrl || !schemaName) throw new Error("Workflow test database is not configured.");

  const prismaBinary = `${process.cwd()}/node_modules/.bin/prisma`;
  const prepared = spawnSync(prismaBinary, ["db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (prepared.status !== 0) {
    throw new Error(`Unable to prepare Workflow test schema. ${redactDatabaseCredentials(prepared.stderr || prepared.stdout)}`);
  }

  return async () => {
    const prisma = new PrismaClient();
    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await prisma.$disconnect();
    }
  };
}

function redactDatabaseCredentials(value: string) {
  return value.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@").trim();
}
