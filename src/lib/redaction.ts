export function redactSensitiveText(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-token]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d\s().-]{8,}\d)\b/g, "[redacted-phone]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
}

export function publicErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? redactSensitiveText(error.message) : typeof error === "string" ? redactSensitiveText(error) : "";
  if (!message) return "操作未完成，请稍后重试。";

  const checks: Array<[RegExp, string]> = [
    [/SERPER_API_KEY|Serper|OpenAlex|GitHub user search|search.*HTTP|搜索.*HTTP/i, "候选搜索服务暂不可用，请稍后重试或先使用已有候选。"],
    [/DASHSCOPE_API_KEY|BAILIAN|GLM|Bailian|Model response was not valid JSON|not valid JSON/i, "智能处理服务暂不可用，请稍后重试或联系管理员检查服务连接。"],
    [/HTTP\s*40[13]|unauthorized|forbidden|permission/i, "服务连接未通过，请联系管理员检查权限。"],
    [/HTTP\s*429|rate.?limit|quota|额度/i, "服务繁忙或额度受限，请稍后重试。"],
    [/Invalid request payload|Zod|validation|Invalid input|expected .* received| at [A-Za-z0-9_.-]+/i, "返回内容格式不完整，请重新生成或联系管理员复核。"],
    [/Marketing campaign output did not contain any channel posts|missed requested channels|channel posts/i, "渠道内容未生成完整，请重新生成渠道草稿。"],
    [/Project not found/i, "项目不存在或已被删除。"],
    [/Candidate not found/i, "候选人不存在或已被删除。"],
    [/Expert not found/i, "专家资料不存在或已被删除。"],
    [/Marketing post not found/i, "渠道内容不存在或已被删除。"],
    [/Cannot transition|Invalid pipeline|Invalid marketing post status/i, "当前状态不能执行该动作，请先完成前置步骤。"],
    [/Unknown server error|server error|HTTP\s*5\d\d/i, "操作未完成，请稍后重试。"],
  ];

  for (const [pattern, replacement] of checks) {
    if (pattern.test(message)) return replacement;
  }

  return message;
}

export function redactForAudit<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactForAudit(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactForAudit(item)]),
    ) as T;
  }
  return value;
}
