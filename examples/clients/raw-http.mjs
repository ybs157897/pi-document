#!/usr/bin/env node
// A2A v1.0 JSON-RPC over fetch; no SDK dependency.

const baseUrl = (process.env.PI_DOCUMENT_AGENT_URL ?? '').replace(/\/+$/, '');
const token = process.env.PI_DOCUMENT_AGENT_TOKEN;
if (!baseUrl || !token) {
  throw new Error('Set PI_DOCUMENT_AGENT_URL and PI_DOCUMENT_AGENT_TOKEN');
}

const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`, {
  headers: { Accept: 'application/json' },
});
if (!cardResponse.ok) throw new Error(`Agent Card request failed with HTTP ${cardResponse.status}`);
const card = await cardResponse.json();
const endpoint = card.supportedInterfaces?.find(
  (item) => item.protocolBinding === 'JSONRPC' && item.protocolVersion === '1.0',
)?.url;
if (!endpoint) throw new Error('Agent Card does not advertise JSONRPC 1.0');

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'A2A-Version': '1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `raw-${++rpcId}`, method, params }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`A2A HTTP request failed with ${response.status}`);
  if (body.error) throw new Error(`A2A ${body.error.code}: ${body.error.message}`);
  return body.result;
}

const { task } = await rpc('SendMessage', {
  message: {
    messageId: `raw-message-${crypto.randomUUID()}`,
    role: 'ROLE_USER',
    parts: [{
      data: {
        schemaVersion: '1.0',
        operation: 'knowledge_base.list',
        requestId: crypto.randomUUID(),
        input: { limit: 10 },
      },
      mediaType: 'application/json',
    }],
  },
  configuration: { acceptedOutputModes: ['application/json'], returnImmediately: true },
});

const latest = await rpc('GetTask', { id: task.id });
console.log(JSON.stringify({ taskId: latest.id, state: latest.status.state }));

if (latest.status.state === 'TASK_STATE_SUBMITTED' || latest.status.state === 'TASK_STATE_WORKING') {
  const canceled = await rpc('CancelTask', { id: latest.id });
  console.log(JSON.stringify({ taskId: canceled.id, state: canceled.status.state }));
}
