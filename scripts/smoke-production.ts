type SmokeResult = {
  name: string;
  ok: boolean;
  detail: string;
};

const baseUrl = process.env.SMOKE_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3001";
const username = process.env.SMOKE_BASIC_USER;
const password = process.env.SMOKE_BASIC_PASSWORD;
const configuredSecrets = [process.env.DASHSCOPE_API_KEY, process.env.SERPER_API_KEY].filter(
  (value): value is string => Boolean(value && value.length >= 12),
);

function containsSensitiveConfiguration(value: string) {
  return (
    /DASHSCOPE_API_KEY|SERPER_API_KEY|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|sk-[A-Za-z0-9_-]{12,}/i.test(value) ||
    configuredSecrets.some((secret) => value.includes(secret))
  );
}

function authHeaders(): HeadersInit {
  if (!username || !password) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}

async function check(name: string, fn: () => Promise<string>): Promise<SmokeResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : "Unknown smoke failure.",
    };
  }
}

async function fetchText(path: string) {
  const response = await fetch(new URL(path, baseUrl), { headers: authHeaders(), redirect: "manual" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(path: string) {
  const response = await fetch(new URL(path, baseUrl), { headers: authHeaders(), redirect: "manual" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function main() {
  const results = await Promise.all([
    check("home page", async () => {
      const html = await fetchText("/");
      if (!/专家|招募|供给/.test(html)) throw new Error("Home page did not contain expected product text.");
      if (containsSensitiveConfiguration(html)) throw new Error("Home page appears to leak sensitive configuration.");
      return "page loads without secret leakage";
    }),
    check("projects api readonly", async () => {
      const json = await fetchJson("/api/projects");
      const payload = JSON.stringify(json);
      if (containsSensitiveConfiguration(payload)) throw new Error("Projects API appears to leak sensitive configuration.");
      return "projects endpoint responds";
    }),
  ]);

  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown smoke failure.");
  process.exit(1);
});

export {};
