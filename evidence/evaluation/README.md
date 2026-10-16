# Retrieval evaluation evidence

Run fixture validation without contacting the embedding service:

```sh
node --import tsx scripts/eval-retrieval.ts --validate-only
```

Run the full evaluation only with the configured real embedding profile:

```sh
node --env-file-if-exists=.env --import tsx scripts/eval-retrieval.ts --live
```

Each live run creates `evidence/evaluation/<run-id>/report.json` before starting. The report is updated after document saves, version updates, HTML snapshot checks, and each query, so setup failures and partial runs retain their evidence. A failed metric gate or incomplete run exits nonzero. The report records lock, environment, model-configuration and fixture hashes without credentials.

The frozen `fixtures/evaluation/frozen` set contributes exactly 100 documents and 100 queries. The answerable, authorized denominator is 85: 20 exact, 30 synonym, 20 cross-passage/document, 10 version, and 5 filtered queries. Ten no-answer queries and five permission-denial queries are reported separately; neither enters Recall@10 or MRR@10. The 20 blind queries were fixed before any retrieval run.

The ten `document.update` cases upload the frozen v2 fixture at `expectedVersion: 1`, require the same document ID at version 2, verify v2 hashes and locators, and check that new keyword searches do not return version 1. Their source fixtures are included in the frozen corpus hash. The separate 20-file HTML snapshot set has SHA-256 `07b825d3fb539ad10ab55b97f1b136bbcda31ed92fe9da5903f487aefde641ae`; it is uploaded to its own KB and checked for parser fragment locators. It does not claim public URL fetch, DNS, or redirect coverage and does not enter the 100-query retrieval metrics.

Latest successful live evaluation: [retrieval-2026-10-16T05-13-53-360Z-156014/report.json](retrieval-2026-10-16T05-13-53-360Z-156014/report.json). Earlier failed runs are retained. The fixed blind split was rerun after implementation fixes; it is a regression group, not a new unseen holdout. Synthetic-only results do not establish retrieval quality on real enterprise documents.
