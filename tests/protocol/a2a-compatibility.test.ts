import assert from "node:assert/strict";
import { after, test } from "node:test";
import { TaskState } from "@a2a-js/sdk";
import {
  createSdkClient,
  getSdkVersion,
  rawJsonRpc,
  rawSendRequest,
  rawSse,
  rawStreamRequest,
  readSseEvents,
  rpcBody,
  sdkSendMessageRequest,
  startCompatibilityHarness,
  writeRuntimeEvidence,
} from "../../scripts/a2a-compatibility.js";

const evidence: Record<string, any> = {
  checkedAt: new Date().toISOString(),
  sdk: {
    package: "@a2a-js/sdk",
    version: getSdkVersion(),
    installedProtocolCardVersion: "1.0",
  },
  probes: {},
  scope: "Real local HTTP and SDK transport behavior with an in-memory executor; not business-service or persistence interoperability.",
};

after(async () => {
  await writeRuntimeEvidence(evidence);
});

function stateOf(task: Record<string, any> | undefined) {
  return task?.status?.state;
}

function streamCase(event: Record<string, any>) {
  const result = event.result ?? {};
  if (result.task) return "task";
  if (result.artifactUpdate) return "artifactUpdate";
  if (result.statusUpdate) return "statusUpdate";
  return "unknown";
}

test("official SDK discovers Card and performs SendMessage, GetTask, and CancelTask", async () => {
  const harness = await startCompatibilityHarness();
  try {
    const cardResponse = await fetch(`${harness.origin}/.well-known/agent-card.json`);
    assert.equal(cardResponse.status, 200);
    const card = await cardResponse.json() as Record<string, any>;
    assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
    assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
    assert.equal(card.supportedInterfaces[0].url, `${harness.origin}/rpc`);

    const client = await createSdkClient(harness);
    const completed = await client.sendMessage(sdkSendMessageRequest("sdk-complete-1", "complete"));
    assert.ok("id" in completed, "SendMessage should return a Task");
    assert.equal(stateOf(completed), TaskState.TASK_STATE_COMPLETED);
    const fetched = await client.getTask({ id: completed.id, tenant: "" });
    assert.equal(fetched.id, completed.id);
    assert.equal(stateOf(fetched), TaskState.TASK_STATE_COMPLETED);
    assert.equal(fetched.artifacts.length, 1);
    assert.deepEqual(fetched.artifacts[0]?.parts[0]?.content, {
      $case: "data",
      value: { outcome: "succeeded", source: "m0-a2a-probe" },
    });

    const held = await client.sendMessage(sdkSendMessageRequest("sdk-cancel-1", "hold", true));
    assert.ok("id" in held, "immediate SendMessage should return a Task");
    assert.equal(stateOf(held), TaskState.TASK_STATE_WORKING);
    const canceled = await client.cancelTask({ id: held.id, tenant: "", metadata: undefined });
    assert.equal(canceled.id, held.id);
    assert.equal(stateOf(canceled), TaskState.TASK_STATE_CANCELED);
    const fetchedCanceled = await client.getTask({ id: held.id, tenant: "" });
    assert.equal(stateOf(fetchedCanceled), TaskState.TASK_STATE_CANCELED);

    const sdkRequests = harness.requests;
    assert.ok(sdkRequests.length >= 5);
    assert.ok(sdkRequests.every((request) => request.version === "1.0"));
    evidence.probes.sdkClient = {
      status: "passed",
      discoveryPath: "/.well-known/agent-card.json",
      cardProtocolVersion: card.supportedInterfaces[0].protocolVersion,
      operations: ["SendMessage", "GetTask", "CancelTask"],
      completedTaskState: "TASK_STATE_COMPLETED",
      canceledTaskState: "TASK_STATE_CANCELED",
      artifactDataPart: fetched.artifacts[0]?.parts[0]?.content,
      observedRequestVersions: [...new Set(sdkRequests.map((request) => request.version))],
    };
  } finally {
    await harness.close();
  }
});

test("raw JSON-RPC SendMessage, GetTask, and CancelTask operate over HTTP", async () => {
  const harness = await startCompatibilityHarness();
  try {
    const sent = rpcBody(await rawJsonRpc(harness, rawSendRequest("raw-cancel-1", "hold", true)));
    const task = sent.result?.task as Record<string, any> | undefined;
    assert.ok(task?.id);
    assert.equal(stateOf(task), "TASK_STATE_WORKING");

    const fetched = rpcBody(await rawJsonRpc(harness, {
      jsonrpc: "2.0",
      id: "raw-get-working",
      method: "GetTask",
      params: { id: task.id },
    }));
    assert.equal(fetched.result?.id, task.id);
    assert.equal(stateOf(fetched.result), "TASK_STATE_WORKING");

    const canceled = rpcBody(await rawJsonRpc(harness, {
      jsonrpc: "2.0",
      id: "raw-cancel",
      method: "CancelTask",
      params: { id: task.id },
    }));
    assert.equal(canceled.result?.id, task.id);
    assert.equal(stateOf(canceled.result), "TASK_STATE_CANCELED");

    const fetchedCanceled = rpcBody(await rawJsonRpc(harness, {
      jsonrpc: "2.0",
      id: "raw-get-canceled",
      method: "GetTask",
      params: { id: task.id },
    }));
    assert.equal(stateOf(fetchedCanceled.result), "TASK_STATE_CANCELED");
    evidence.probes.rawJsonRpcLifecycle = {
      status: "passed",
      operations: ["SendMessage", "GetTask", "CancelTask", "GetTask"],
      states: [stateOf(task), stateOf(fetched.result), stateOf(canceled.result), stateOf(fetchedCanceled.result)],
      observedRequestVersions: [...new Set(harness.requests.map((request) => request.version))],
    };
  } finally {
    await harness.close();
  }
});

test("raw SSE streaming starts with a task snapshot and ends at a terminal state", async () => {
  const harness = await startCompatibilityHarness();
  try {
    const sendStreaming = rawSendRequest("raw-stream-1", "hold", true);
    const streamingResponse = await rawSse(
      harness,
      rawStreamRequest("SendStreamingMessage", "rpc-stream-1", sendStreaming.params as Record<string, unknown>),
    );
    assert.equal(streamingResponse.status, 200);
    assert.match(streamingResponse.headers.get("content-type") ?? "", /^text\/event-stream/i);
    const streamingEvents: Record<string, any>[] = [];
    for await (const event of readSseEvents(streamingResponse)) {
      streamingEvents.push(event);
      if (streamingEvents.length === 1) {
        const snapshot = event.result?.task as Record<string, any> | undefined;
        assert.ok(snapshot?.id, "the first SSE event must be the Task snapshot");
        assert.equal(stateOf(snapshot), "TASK_STATE_WORKING");
        harness.complete(snapshot.id);
      }
    }
    assert.deepEqual(streamingEvents.map(streamCase), ["task", "artifactUpdate", "statusUpdate"]);
    assert.equal(streamingEvents.at(-1)?.result?.statusUpdate?.status?.state, "TASK_STATE_COMPLETED");

    const submitted = rpcBody(await rawJsonRpc(harness, rawSendRequest("raw-subscribe-1", "hold", true)));
    const subscribedTask = submitted.result?.task as Record<string, any> | undefined;
    assert.ok(subscribedTask?.id);
    const subscribeResponse = await rawSse(
      harness,
      rawStreamRequest("SubscribeToTask", "rpc-subscribe-1", { id: subscribedTask.id }),
    );
    assert.equal(subscribeResponse.status, 200);
    assert.match(subscribeResponse.headers.get("content-type") ?? "", /^text\/event-stream/i);
    const subscribeEvents: Record<string, any>[] = [];
    for await (const event of readSseEvents(subscribeResponse)) {
      subscribeEvents.push(event);
      if (subscribeEvents.length === 1) {
        const snapshot = event.result?.task as Record<string, any> | undefined;
        assert.equal(snapshot?.id, subscribedTask.id);
        assert.equal(stateOf(snapshot), "TASK_STATE_WORKING");
        harness.complete(subscribedTask.id);
      }
    }
    assert.deepEqual(subscribeEvents.map(streamCase), ["task", "artifactUpdate", "statusUpdate"]);
    assert.equal(subscribeEvents.at(-1)?.result?.statusUpdate?.status?.state, "TASK_STATE_COMPLETED");

    evidence.probes.rawSse = {
      status: "passed",
      sendStreamingMessage: {
        contentType: streamingResponse.headers.get("content-type"),
        firstEventCase: streamCase(streamingEvents[0]!),
        eventCases: streamingEvents.map(streamCase),
        terminalState: streamingEvents.at(-1)?.result?.statusUpdate?.status?.state,
        streamClosedAfterTerminal: true,
      },
      subscribeToTask: {
        contentType: subscribeResponse.headers.get("content-type"),
        firstEventCase: streamCase(subscribeEvents[0]!),
        eventCases: subscribeEvents.map(streamCase),
        terminalState: subscribeEvents.at(-1)?.result?.statusUpdate?.status?.state,
        streamClosedAfterTerminal: true,
      },
    };
  } finally {
    await harness.close();
  }
});

test("server rejects unsupported protocol versions and malformed JSON-RPC parameters", async () => {
  const harness = await startCompatibilityHarness();
  try {
    const unsupported = rpcBody(await rawJsonRpc(harness, {
      jsonrpc: "2.0", id: "version-101", method: "GetTask", params: { id: "unknown" },
    }, { version: "1.0.1" }));
    assert.equal(unsupported.error?.code, -32009);

    const absentVersion = rpcBody(await rawJsonRpc(harness, {
      jsonrpc: "2.0", id: "version-absent", method: "GetTask", params: { id: "unknown" },
    }, { version: null }));
    assert.equal(absentVersion.error?.code, -32009);

    const invalidParams = rpcBody(await rawJsonRpc(harness, {
      jsonrpc: "2.0", id: "invalid-params", method: "SendMessage", params: {},
    }));
    assert.equal(invalidParams.error?.code, -32602);

    const unknownMethod = rpcBody(await rawJsonRpc(harness, {
      jsonrpc: "2.0", id: "unknown-method", method: "UnknownA2AMethod", params: {},
    }));
    assert.equal(unknownMethod.error?.code, -32601);

    evidence.probes.versionAndParameterErrors = {
      status: "passed",
      unsupportedVersion: { header: "1.0.1", code: unsupported.error.code },
      absentVersion: { header: null, code: absentVersion.error.code },
      invalidParameters: { method: "SendMessage", code: invalidParams.error.code },
      unknownMethod: { method: "UnknownA2AMethod", code: unknownMethod.error.code },
    };
  } finally {
    await harness.close();
  }
});
