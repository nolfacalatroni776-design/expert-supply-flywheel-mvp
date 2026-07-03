import { PrismaClient } from "@prisma/client";
import { ensureRuntimeDatabase, ensureSqliteDirectoryFromEnv } from "@/lib/runtime-db";

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
  rawPrisma?: PrismaClient;
};

ensureSqliteDirectoryFromEnv();

const rawPrisma =
  globalForPrisma.rawPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

const runtimeReady = ensureRuntimeDatabase(rawPrisma);

function createPrismaClient(client: PrismaClient) {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          await runtimeReady;
          return query(args);
        },
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient(rawPrisma);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.rawPrisma = rawPrisma;
  globalForPrisma.prisma = prisma;
}
