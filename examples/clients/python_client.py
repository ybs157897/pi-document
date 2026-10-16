#!/usr/bin/env python3
"""Minimal standard-library A2A v1.0 JSON-RPC client for stored text saves."""

import json
import os
import time
import urllib.error
import urllib.request
import uuid


BASE_URL = os.environ.get("PI_DOCUMENT_AGENT_URL", "").rstrip("/")
TOKEN = os.environ.get("PI_DOCUMENT_AGENT_TOKEN", "")
KNOWLEDGE_BASE_ID = os.environ.get("PI_DOCUMENT_KNOWLEDGE_BASE_ID", "")


def request_json(
    url: str,
    *,
    method: str = "GET",
    body: dict | None = None,
    a2a: bool = False,
    authenticated: bool = True,
):
    headers = {"Accept": "application/json"}
    if authenticated and TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if a2a:
        headers["A2A-Version"] = "1.0"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from None


def main() -> None:
    if not BASE_URL or not TOKEN or not KNOWLEDGE_BASE_ID:
        raise SystemExit("Set PI_DOCUMENT_AGENT_URL, PI_DOCUMENT_AGENT_TOKEN, and PI_DOCUMENT_KNOWLEDGE_BASE_ID")

    card = request_json(f"{BASE_URL}/.well-known/agent-card.json", authenticated=False)
    interface = next(
        (item for item in card.get("supportedInterfaces", [])
         if item.get("protocolBinding") == "JSONRPC" and item.get("protocolVersion") == "1.0"),
        None,
    )
    if interface is None:
        raise SystemExit("Agent Card does not advertise JSONRPC 1.0")
    rpc_url = interface["url"]

    request_id = str(uuid.uuid4())
    payload = {
        "schemaVersion": "1.0",
        "operation": "document.save",
        "requestId": request_id,
        "knowledgeBaseId": KNOWLEDGE_BASE_ID,
        "input": {
            "source": {"kind": "text", "text": "A2A M1 stored-text client example.", "mimeType": "text/markdown"},
            "title": "A2A client example",
            "waitFor": "stored",
        },
    }
    sent = request_json(rpc_url, method="POST", a2a=True, body={
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": str(uuid.uuid4()),
                "role": "ROLE_USER",
                "parts": [{"data": payload, "mediaType": "application/json"}],
            },
            "configuration": {"acceptedOutputModes": ["application/json"], "returnImmediately": True},
        },
    })
    if "error" in sent:
        raise RuntimeError(f"A2A error: {sent['error']}")
    task = sent["result"]["task"]

    deadline = time.monotonic() + 60
    while task["status"]["state"] in ("TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"):
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Task {task['id']} did not finish within 60 seconds")
        time.sleep(0.1)
        fetched = request_json(rpc_url, method="POST", a2a=True, body={
            "jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "GetTask", "params": {"id": task["id"]},
        })
        if "error" in fetched:
            raise RuntimeError(f"A2A error: {fetched['error']}")
        task = fetched["result"]

    print(json.dumps({"taskId": task["id"], "state": task["status"]["state"]}))


if __name__ == "__main__":
    main()
