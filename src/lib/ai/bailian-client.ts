import { z, type ZodType } from "zod";

export type BailianResult<T> =
  | {
      ok: true;
      data: T;
      rawText: string;
      usage: unknown;
      error?: never;
    }
  | {
      ok: false;
      data?: never;
      rawText: string;
      usage: unknown;
      error: string;
      status?: number;
    };

type BailianChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: unknown;
  error?: {
    message?: string;
    code?: string;
  };
};

const MAX_MODEL_ATTEMPTS = 3;
const MAX_OUTPUT_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

export class MissingBailianKeyError extends Error {
  constructor() {
    super("DASHSCOPE_API_KEY is not configured.");
    this.name = "MissingBailianKeyError";
  }
}

export class BailianClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly models: string[];
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxOutputAttempts: number;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    maxAttempts?: number;
    maxOutputAttempts?: number;
  }) {
    this.apiKey = options?.apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.baseUrl =
      options?.baseUrl ??
      process.env.DASHSCOPE_BASE_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    this.timeoutMs = parsePositiveInteger(options?.timeoutMs ?? process.env.BAILIAN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.maxAttempts = Math.min(MAX_MODEL_ATTEMPTS, parsePositiveInteger(options?.maxAttempts, MAX_MODEL_ATTEMPTS));
    this.maxOutputAttempts = Math.min(
      MAX_OUTPUT_ATTEMPTS,
      parsePositiveInteger(options?.maxOutputAttempts, MAX_OUTPUT_ATTEMPTS),
    );
    const primaryModel = options?.model ?? process.env.BAILIAN_MODEL ?? "glm-5.2";
    const fallbackModels = (process.env.BAILIAN_FALLBACK_MODELS ?? "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    this.models = Array.from(new Set([primaryModel, ...fallbackModels, "glm-5.2"]));
  }

  async runStructured<T>({
    taskName,
    systemPrompt,
    userPayload,
    schema,
  }: {
    taskName: string;
    systemPrompt: string;
    userPayload: unknown;
    schema: ZodType<T>;
  }): Promise<BailianResult<T>> {
    if (!this.apiKey) {
      throw new MissingBailianKeyError();
    }

    let lastFailure: BailianResult<T> | null = null;
    for (const model of this.models) {
      let result: BailianResult<T> | null = null;
      let repairFeedback = "";
      for (let outputAttempt = 1; outputAttempt <= this.maxOutputAttempts; outputAttempt += 1) {
        result = await this.callModel<T>({ taskName, systemPrompt, userPayload, schema, model, repairFeedback });
        if (result.ok) return result;
        lastFailure = result;
        if (outputAttempt >= this.maxOutputAttempts || !shouldRetryStructuredOutput(result)) break;
        repairFeedback = result.error.slice(0, 1_500);
      }
      if (result && !shouldTryFallback(result)) {
        return result;
      }
    }

    return lastFailure ?? {
      ok: false,
      rawText: "",
      usage: null,
      error: "Bailian request failed before model call.",
    };
  }

  private async callModel<T>({
    taskName,
    systemPrompt,
    userPayload,
    schema,
    model,
    repairFeedback,
  }: {
    taskName: string;
    systemPrompt: string;
    userPayload: unknown;
    schema: ZodType<T>;
    model: string;
    repairFeedback?: string;
  }): Promise<BailianResult<T>> {
    const requestBody = JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: [
              systemPrompt,
              "Return only valid JSON. Do not wrap the JSON in Markdown fences.",
              repairFeedback
                ? `The previous response did not satisfy the required JSON structure. Return a complete corrected object. Validation feedback: ${repairFeedback}`
                : "",
              `Task name: ${taskName}`,
            ].filter(Boolean).join("\n\n"),
          },
          {
            role: "user",
            content: JSON.stringify(userPayload),
          },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        enable_thinking: false,
        reasoning_effort: "none",
      });
    const responseUrl = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let response: Response | null = null;
    let body: BailianChatResponse = {};
    let networkError = "";

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const timeout = createTimeoutSignal(this.timeoutMs);
      try {
        response = await fetch(responseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
          signal: timeout.signal,
        });
        body = (await response.json().catch(() => ({}))) as BailianChatResponse;
        if (!shouldRetryHttp(response.status) || attempt === this.maxAttempts) break;
      } catch (error) {
        networkError = error instanceof Error ? error.message : "Network request failed.";
        if (attempt === this.maxAttempts) {
          return {
            ok: false,
            rawText: "",
            usage: null,
            error: `Bailian network request failed: ${networkError}`,
          };
        }
      } finally {
        timeout.cancel();
      }
      await waitBeforeRetry(attempt);
    }

    if (!response) {
      return {
        ok: false,
        rawText: "",
        usage: null,
        error: `Bailian network request failed${networkError ? `: ${networkError}` : "."}`,
      };
    }

    const rawText = body.choices?.[0]?.message?.content ?? "";
    const usage = body.usage ?? null;

    if (!response.ok) {
      return {
        ok: false,
        rawText,
        usage,
        status: response.status,
        error: body.error?.message ?? `Bailian request failed with HTTP ${response.status}.`,
      };
    }

    if (!rawText.trim()) {
      return {
        ok: false,
        rawText,
        usage,
        error: "Bailian returned an empty response.",
      };
    }

    const parsedJson = parseModelJson(rawText);
    if (!parsedJson.ok) {
      return {
        ok: false,
        rawText,
        usage,
        error: parsedJson.error,
      };
    }

    const parsedSchema = schema.safeParse(parsedJson.value);
    if (!parsedSchema.success) {
      return {
        ok: false,
        rawText,
        usage,
        error: z.prettifyError(parsedSchema.error),
      };
    }

    return {
      ok: true,
      data: parsedSchema.data,
      rawText,
      usage,
    };
  }
}

function shouldRetryStructuredOutput(result: { status?: number; error: string; rawText: string }) {
  if (result.status) return false;
  if (result.rawText.trim()) return true;
  return /empty response|not valid json/i.test(result.error);
}

function shouldTryFallback(result: { status?: number; error: string }) {
  const error = result.error.toLowerCase();
  if ([400, 403, 404, 422].includes(result.status ?? 0)) {
    return /model|access|permission|unsupported|parameter|not found|not available/.test(error);
  }
  return false;
}

function shouldRetryHttp(status: number) {
  return status === 429 || status >= 500;
}

function waitBeforeRetry(attempt: number) {
  if (process.env.NODE_ENV === "test") return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, attempt * 250));
}

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function parsePositiveInteger(value: string | number | undefined, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

export function parseModelJson(rawText: string):
  | { ok: true; value: unknown }
  | { ok: false; error: string } {
  const cleaned = rawText
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    const objectStart = cleaned.indexOf("{");
    const arrayStart = cleaned.indexOf("[");
    const parsers =
      arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)
        ? [
            () => parseJsonFragment(cleaned, "[", "]"),
            () => parseJsonFragment(cleaned, "{", "}"),
          ]
        : [
            () => parseJsonFragment(cleaned, "{", "}"),
            () => parseJsonFragment(cleaned, "[", "]"),
          ];
    for (const parse of parsers) {
      const result = parse();
      if (result.ok) return result;
    }
    return { ok: false, error: "Model response was not valid JSON." };
  }
}

function parseJsonFragment(rawText: string, open: "{" | "[", close: "}" | "]"):
  | { ok: true; value: unknown }
  | { ok: false } {
  const first = rawText.indexOf(open);
  const last = rawText.lastIndexOf(close);
  if (first < 0 || last <= first) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(rawText.slice(first, last + 1)) };
  } catch {
    return { ok: false };
  }
}
