"""Independent standard-library A2A v1.0 client acceptance; no project SDK imports."""
import hashlib
import json
import os
import time
import urllib.request
import urllib.parse
import uuid

base = os.environ["PI_DOCUMENT_AGENT_URL"].rstrip("/")
token = os.environ["PI_DOCUMENT_AGENT_TOKEN"]
kb_id = os.environ["PI_DOCUMENT_KNOWLEDGE_BASE_ID"]


def request(url, body=None, authenticated=True):
    headers = {"Accept": "application/json"}
    if authenticated:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers.update({"Content-Type": "application/json", "A2A-Version": "1.0"})
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=90) as response:
        return response.read()


card = json.loads(request(base + "/.well-known/agent-card.json", authenticated=False))
endpoint = next(item["url"] for item in card["supportedInterfaces"]
                if item["protocolBinding"] == "JSONRPC" and item["protocolVersion"] == "1.0")
assert urllib.parse.urlsplit(endpoint).netloc == urllib.parse.urlsplit(base).netloc


def rpc(method, params):
    result = json.loads(request(endpoint, {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params}))
    if "error" in result:
        raise RuntimeError(str(result["error"]))
    return result["result"]


def operation(name, payload):
    task = rpc("SendMessage", {"message": {"messageId": str(uuid.uuid4()), "role": "ROLE_USER", "parts": [{
        "mediaType": "application/json", "data": {"schemaVersion": "1.0", "operation": name, "requestId": str(uuid.uuid4()),
                                                   "knowledgeBaseId": kb_id, "input": payload}
    }]}, "configuration": {"acceptedOutputModes": ["application/json"], "returnImmediately": True}})["task"]
    deadline = time.monotonic() + 90
    while task["status"]["state"] in ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"]:
        assert time.monotonic() < deadline, "Task did not finish"
        time.sleep(0.05)
        task = rpc("GetTask", {"id": task["id"]})
    assert task["status"]["state"] == "TASK_STATE_COMPLETED", task
    result = task["artifacts"][0]["parts"][0]["data"]
    assert result["outcome"] == "succeeded", result
    return result["result"]


source = "Python 独立客户端验收 PY-2026-001：资料上传完成后必须可以搜索，并按授权读取同一版本原文。"
saved = operation("document.save", {"title": "Python 独立客户端验收", "source": {"kind": "text", "text": source}, "waitFor": "indexed"})
assert saved["indexState"] == "ready"
assert saved["sha256"] == hashlib.sha256(source.encode()).hexdigest()
searched = operation("document.search", {"query": "PY-2026-001 上传后搜索与原文读取", "topK": 5, "mode": "hybrid", "rerank": False})
hit = next(item for item in searched["results"] if item["documentId"] == saved["documentId"])
assert request(hit["contentUri"]).decode() == source
print(json.dumps({"status": "passed", "client": "Python standard library", "documentId": saved["documentId"],
                  "version": hit["version"], "sourceSha256": saved["sha256"], "hitCount": len(searched["results"])}))
