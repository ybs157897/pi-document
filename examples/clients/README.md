# A2A client examples

Both examples discover the public Agent Card, select its JSON-RPC 1.0 interface, and send the token only in the `Authorization` header.

Set `PI_DOCUMENT_AGENT_URL` to the service's public base URL and `PI_DOCUMENT_AGENT_TOKEN` to an issued Bearer token. For the Python save example, also set `PI_DOCUMENT_KNOWLEDGE_BASE_ID` to an authorized knowledge-base ID.

Run the Python client with `python3 examples/clients/python_client.py`. It submits a text `document.save` with `waitFor: "stored"`, polls the returned task, and prints only the task ID and final state. Run the Node raw-HTTP example with `node examples/clients/raw-http.mjs`; it demonstrates discovery, `SendMessage`, `GetTask`, and `CancelTask` without an A2A SDK dependency.

The Node multipart example uses `PI_DOCUMENT_UPLOAD_FILE` to read a local client-side file and upload its bytes as the `file` field. It supports TXT, MD, PDF, DOCX, and HTML. Run it with `node examples/clients/multipart-upload.mjs`; the server receives no filesystem path. The gateway requires `knowledge:write`, enforces a 50 MiB per-file limit and upload concurrency limits, and returns HTTP 501 when the configured backend does not implement uploads.

The PostgreSQL backend has a stored-only mode and an indexing mode. Without an embedding pipeline, it supports knowledge-base create/list, text `document.save` with `waitFor: "stored"`, document get/list, and A2A task operations; search, updates, deletes, URL sources, and non-text saves are unavailable. With the embedding pipeline configured, the gateway advertises indexed save/search and supports document update/delete plus text, multipart upload, and public-URL sources. Indexed uploads accept TXT, MD, PDF, DOCX, and HTML up to 50 MiB per file. The `document.search` result uses lexical/vector hybrid retrieval; reranking is not configured and is reported as a degradation reason.

The natural-language Agent runtime is enabled only when `AGENT_MODEL_PROFILE` and its credential are configured. In that mode, the Card advertises `text/plain` input/output. Run `node examples/clients/natural-text.mjs` to send a TextPart and continue the same task/context after an `INPUT_REQUIRED` clarification. This example demonstrates the runtime path; it does not by itself establish final natural-language acceptance or retrieval quality. Current model, parser, and remaining acceptance boundaries are recorded in [`docs/08-implementation-handoff.md`](../../docs/08-implementation-handoff.md) and [`docs/07-acceptance.md`](../../docs/07-acceptance.md).
