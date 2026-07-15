type OutreachDraft = {
  subject: string;
  body: string;
  replyTemplates: Record<string, string>;
};

type GenerationResult =
  | { ok: true; data: OutreachDraft; rawText: string; usage: unknown }
  | { ok: false; error: string; rawText?: string; usage?: unknown; status?: number };

export async function generateOutreachDraftWithRecovery({
  generate,
  fallback,
}: {
  generate: () => Promise<GenerationResult>;
  fallback: () => OutreachDraft;
}) {
  const failures: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await generate();
    if (result.ok) {
      return {
        draft: result.data,
        fallback: false,
        attempts: attempt,
        failures,
        usage: result.usage,
      };
    }

    failures.push(result.error);
    if (!shouldRetryStructuredOutreach(result) || attempt === 2) break;
  }

  return {
    draft: fallback(),
    fallback: true,
    attempts: failures.length,
    failures,
    usage: null,
  };
}

function shouldRetryStructuredOutreach(result: Extract<GenerationResult, { ok: false }>) {
  if (result.status !== undefined) return false;
  return Boolean(result.rawText?.trim());
}
