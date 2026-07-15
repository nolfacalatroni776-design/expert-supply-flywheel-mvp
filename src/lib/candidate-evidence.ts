type EvidenceLike = {
  id: string;
  claim: string;
  sourceUrl: string;
  sourceTitle: string | null;
  snippet: string;
  evidenceLevel: string;
  confidence: number;
};

export function groupEvidenceBySource(items: EvidenceLike[]) {
  const groups = new Map<
    string,
    {
      sourceUrl: string;
      sourceTitle: string | null;
      evidenceLevel: string;
      confidence: number;
      claims: string[];
      snippets: string[];
    }
  >();

  for (const item of items) {
    const key = item.sourceUrl.trim() || item.id;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        sourceUrl: item.sourceUrl,
        sourceTitle: item.sourceTitle,
        evidenceLevel: item.evidenceLevel,
        confidence: item.confidence,
        claims: uniqueText([item.claim]),
        snippets: uniqueText([item.snippet]),
      });
      continue;
    }

    current.sourceTitle ||= item.sourceTitle;
    if (evidenceRank(item.evidenceLevel) > evidenceRank(current.evidenceLevel)) current.evidenceLevel = item.evidenceLevel;
    current.confidence = Math.max(current.confidence, item.confidence);
    current.claims = uniqueText([...current.claims, item.claim]);
    current.snippets = uniqueText([...current.snippets, item.snippet]);
  }

  return Array.from(groups.values());
}

function uniqueText(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function evidenceRank(level: string) {
  const ranks: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };
  return ranks[level.toUpperCase()] ?? 0;
}
