import { createHash } from 'node:crypto';
import { parseSource } from '../ingestion/parser.js';
import { chunkDocument, CHUNK_MAX_UTF8_BYTES, CHUNK_OVERLAP_UTF8_BYTES } from '../ingestion/chunker.js';
import { createEmbeddingClient, type EmbeddingProfile } from '../retrieval/embedding.js';
import { tokenize } from '../retrieval/lexical.js';
import type { DocumentPipeline } from '../domain/types.js';

export function createDocumentPipeline(profile: EmbeddingProfile): DocumentPipeline {
  const client = createEmbeddingClient(profile);
  const id = createHash('sha256').update(JSON.stringify({
    baseUrl: profile.baseUrl, model: profile.modelId, dimensions: profile.dimensions,
    version: profile.version, normalization: profile.normalization,
    parserVersion: 1, chunkMaxBytes: CHUNK_MAX_UTF8_BYTES, overlapBytes: CHUNK_OVERLAP_UTF8_BYTES,
    tokenizer: 'Intl.Segmenter:zh', icu: process.versions.icu,
  })).digest('hex');
  return {
    profile: { id, dimensions: profile.dimensions, version: profile.version },
    async parse(bytes, mimeType, signal) {
      const parsed = await parseSource(bytes, mimeType, signal);
      const chunks = chunkDocument(parsed).map(chunk => ({ ordinal: chunk.ordinal, text: chunk.text, locator: { ...chunk.locator }, lexicalTokens: chunk.lexicalTokens }));
      return { text: parsed.text, chunks, warnings: parsed.warnings };
    },
    async embed(texts, signal) {
      const vectors: number[][] = [];
      for (let index = 0; index < texts.length; index += 8) vectors.push(...await client.embed(texts.slice(index, index + 8), signal));
      return vectors;
    },
    tokenize,
  };
}
