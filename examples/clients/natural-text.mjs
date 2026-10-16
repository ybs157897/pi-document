import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.PI_DOCUMENT_AGENT_URL ?? '').replace(/\/+$/, '');
const token = process.env.PI_DOCUMENT_AGENT_TOKEN ?? '';
if (!baseUrl || !token) throw new Error('Set PI_DOCUMENT_AGENT_URL and PI_DOCUMENT_AGENT_TOKEN');

async function requestJson(url, { method = 'GET', body, authenticated = true, a2a = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (authenticated) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (a2a) headers['A2A-Version'] = '1.0';
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`Request failed (${response.status}): ${JSON.stringify(payload.error ?? payload)}`);
  }
  return payload;
}

const card = await requestJson(`${baseUrl}/.well-known/agent-card.json`, { authenticated: false });
if (!card.defaultInputModes?.includes('text/plain') || !card.defaultOutputModes?.includes('text/plain')) {
  throw new Error('The Agent Card does not advertise natural-language TextParts');
}
const rpcUrl = card.supportedInterfaces?.find(item => item.protocolBinding === 'JSONRPC' && item.protocolVersion === '1.0')?.url;
if (!rpcUrl) throw new Error('The Agent Card does not advertise JSON-RPC 1.0');

const readline = createInterface({ input: stdin, output: stdout });
const initialText = process.argv.slice(2).join(' ') || '请列出我有权访问的知识库。';
let task = (await requestJson(rpcUrl, {
  method: 'POST',
  a2a: true,
  body: {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'SendMessage',
    params: {
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: initialText, mediaType: 'text/plain' }] },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
    },
  },
})).result.task;

try {
  for (;;) {
    while (task.status.state === 'TASK_STATE_SUBMITTED' || task.status.state === 'TASK_STATE_WORKING') {
      await new Promise(resolve => setTimeout(resolve, 200));
      task = (await requestJson(rpcUrl, {
        method: 'POST',
        a2a: true,
        body: { jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: task.id } },
      })).result;
    }

    if (task.status.state === 'TASK_STATE_INPUT_REQUIRED') {
      const question = task.status.message?.parts?.find(part => typeof part.text === 'string')?.text ?? 'Please clarify your request.';
      const reply = await readline.question(`${question}\n> `);
      task = (await requestJson(rpcUrl, {
        method: 'POST',
        a2a: true,
        body: {
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'SendMessage',
          params: {
            message: {
              messageId: randomUUID(),
              taskId: task.id,
              contextId: task.contextId,
              role: 'ROLE_USER',
              parts: [{ text: reply, mediaType: 'text/plain' }],
            },
            configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
          },
        },
      })).result.task;
      continue;
    }

    if (task.status.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`Natural-language task ended in ${task.status.state}`);
    }
    const answer = task.artifacts?.flatMap(artifact => artifact.parts ?? []).find(part => typeof part.text === 'string')?.text;
    if (answer) console.log(answer);
    console.log(JSON.stringify({ taskId: task.id, contextId: task.contextId, state: task.status.state }));
    break;
  }
} finally {
  readline.close();
}
