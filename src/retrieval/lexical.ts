const chineseSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function tokenize(text: string): string[] {
  return [...chineseSegmenter.segment(text)]
    .filter(part => part.isWordLike)
    .map(part => part.segment.toLowerCase());
}

/** Compound identifiers exclude conversational filler; ordinary lexical terms retain conjunction precision. */
export function lexicalQuery(text: string, tokens: readonly string[]): { text: string; syntax: 'plain' | 'tsquery' } {
  const terms = (values: readonly string[]) => [...new Set(values.flatMap(value => value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []))].slice(0, 64);
  const quoted = (values: readonly string[]) => terms(values).map(value => `'${value}'`);
  // Preserve compound record identifiers as a conjunction, rather than matching a common numeric suffix alone.
  const identifiers = [...new Set(text.match(/\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g) ?? [])]
    .filter(value => /\d/.test(value)).slice(0, 16);
  if (identifiers.length) return { text: identifiers.map(value => `(${quoted(tokenize(value)).join(' & ')})`).join(' | '), syntax: 'tsquery' };
  // PostgreSQL's plain parser keeps decimal and apostrophe tokenization aligned with to_tsvector.
  return { text: tokens.join(' '), syntax: 'plain' };
}

export interface RankedChunk {
  chunkId: string;
  rank: number;
}

export interface FusedChunk {
  chunkId: string;
  score: number;
  rank: number;
}

export function rrf(rankings: readonly (readonly RankedChunk[])[], k = 60): FusedChunk[] {
  if (!Number.isInteger(k) || k < 1) throw new RangeError('RRF_K_INVALID');
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const bestRankByChunk = new Map<string, number>();
    for (const item of ranking) {
      if (!item.chunkId || !Number.isInteger(item.rank) || item.rank < 1) throw new TypeError('RRF_RANKING_INVALID');
      const prior = bestRankByChunk.get(item.chunkId);
      if (prior === undefined || item.rank < prior) bestRankByChunk.set(item.chunkId, item.rank);
    }
    for (const [chunkId, rank] of bestRankByChunk) {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (k + rank));
    }
  }
  return [...scores]
    .sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0))
    .map(([chunkId, score], index) => ({ chunkId, score, rank: index + 1 }));
}
