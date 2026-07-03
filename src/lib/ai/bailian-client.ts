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

  constructor(options?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.apiKey = options?.apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.baseUrl =
      options?.baseUrl ??
      process.env.DASHSCOPE_BASE_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const primaryModel = options?.model ?? process.env.BAILIAN_MODEL ?? "ZHIPU/GLM-5.2";
    const fallbackModels = (process.env.BAILIAN_FALLBACK_MODELS ?? "glm-5.2")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    this.models = Array.from(new Set([primaryModel, ...fallbackModels]));
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
      const result = await this.callModel<T>({ taskName, systemPrompt, userPayload, schema, model });
      if (result.ok) return result;
      lastFailure = result;
      if (!shouldTryFallback(result)) {
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
  }: {
    taskName: string;
    systemPrompt: string;
    userPayload: unknown;
    schema: ZodType<T>;
    model: string;
  }): Promise<BailianResult<T>> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: [
              systemPrompt,
              "Return only valid JSON. Do not wrap the JSON in Markdown fences.",
              `Task name: ${taskName}`,
            ].join("\n\n"),
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
      }),
    });

    const body = (await response.json().catch(() => ({}))) as BailianChatResponse;
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

function shouldTryFallback(result: { status?: number; error: string }) {
  const error = result.error.toLowerCase();
  if ([400, 403, 404, 422].includes(result.status ?? 0)) {
    return /model|access|permission|unsupported|parameter|not found|not available/.test(error);
  }
  return false;
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
