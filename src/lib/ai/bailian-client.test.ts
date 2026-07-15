import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BailianClient, MissingBailianKeyError, parseModelJson } from "./bailian-client";

describe("parseModelJson", () => {
  it("parses plain JSON", () => {
    expect(parseModelJson('{"ok":true}')).toEqual({ ok: true, value: { ok: true } });
  });

  it("parses fenced JSON", () => {
    expect(parseModelJson('```json\n{"ok":true}\n```')).toEqual({ ok: true, value: { ok: true } });
  });

  it("reports invalid JSON", () => {
    const result = parseModelJson("not json");
    expect(result.ok).toBe(false);
  });

  it("extracts a top-level JSON array from model prose", () => {
    expect(parseModelJson('Candidates:\n[{"name":"A"}]')).toEqual({ ok: true, value: [{ name: "A" }] });
  });
});

describe("BailianClient", () => {
  it("throws when API key is missing", async () => {
    const client = new BailianClient({ apiKey: "" });
    await expect(
      client.runStructured({
        taskName: "test",
        systemPrompt: "test",
        userPayload: {},
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toBeInstanceOf(MissingBailianKeyError);
  });

  it("returns parsed structured data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 10 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });

  it("retries one schema-invalid model output with corrective instructions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"ok":"yes"}' } }],
          usage: { total_tokens: 8 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 10 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondRequest.messages[0].content).toContain("previous response");
    expect(secondRequest.messages[0].content).toContain("required JSON structure");
    vi.unstubAllGlobals();
  });

  it("bounds structured-output retries when the model remains invalid", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ok":"still-not-boolean"}' } }],
        usage: { total_tokens: 8 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("returns HTTP failures without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "Unauthorized" } }),
      }),
    );

    const client = new BailianClient({ apiKey: "bad-key", baseUrl: "https://example.com/v1", model: "test-model" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    vi.unstubAllGlobals();
  });

  it("falls back when the primary model is not enabled for the key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "Model access denied." } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 12 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BAILIAN_FALLBACK_MODELS", "fallback-model");

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1", model: "primary-model" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("primary-model");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).model).toBe("fallback-model");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("falls back when the primary model rejects unsupported parameters", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "unsupported parameter response_format" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 12 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BAILIAN_FALLBACK_MODELS", "fallback-model");

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1", model: "primary-model" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps the known compatible GLM alias as a fallback even when env fallback is misconfigured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "Model access denied." } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 12 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BAILIAN_MODEL", "ZHIPU/GLM-5.2");
    vi.stubEnv("BAILIAN_FALLBACK_MODELS", "ZHIPU/GLM-5.2");

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("ZHIPU/GLM-5.2");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).model).toBe("glm-5.2");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("retries transient network failures before reporting workflow failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 12 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1", model: "glm-5.2" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("allows latency-sensitive tasks to disable retry attempts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new BailianClient({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "glm-5.2",
      maxAttempts: 1,
    });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("retries transient Bailian HTTP failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: { message: "Bad gateway" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 12 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BailianClient({ apiKey: "test-key", baseUrl: "https://example.com/v1", model: "glm-5.2" });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("adds a timeout signal to Bailian requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 12 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BailianClient({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "glm-5.2",
      timeoutMs: 1000,
    });
    const result = await client.runStructured({
      taskName: "test",
      systemPrompt: "test",
      userPayload: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });
});
