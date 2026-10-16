import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Role, TaskState, type AgentCard, type SendMessageRequest } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

export interface CapturedRequest {
  method?: string;
  version: string | null;
}

export interface CompatibilityHarness {
  readonly origin: string;
  readonly card: AgentCard;
  readonly requests: CapturedRequest[];
  complete(taskId: string): void;
  close(): Promise<void>;
}

type HeldTask = {
  contextId: string;
  eventBus: ExecutionEventBus;
  release: (result: "complete" | "cancel") => void;
};

function taskStatus(state: TaskState) {
  return {
    state,
    message: undefined,
    timestamp: new Date().toISOString(),
  };
}

function dataFromMessage(message: { parts: Array<{ content?: { $case: string; value: unknown } }> }) {
  const content = message.parts[0]?.content;
  if (content?.$case !== "data" || typeof content.value !== "object" || content.value === null) {
    return {} as Record<string, unknown>;
  }
  return content.value as Record<string, unknown>;
}

function rawMessage(messageId: string, mode: string, returnImmediately: boolean) {
  return {
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [{ data: { mode }, mediaType: "application/json" }],
    },
    configuration: {
      acceptedOutputModes: ["application/json"],
      returnImmediately,
    },
  };
}

export function sdkSendMessageRequest(
  messageId: string,
  mode: string,
  returnImmediately = false,
): SendMessageRequest {
  return {
    tenant: "",
    message: {
      messageId,
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "data", value: { mode } },
          mediaType: "application/json",
          filename: "",
          metadata: undefined,
        },
      ],
      contextId: "",
      taskId: "",
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ["application/json"],
      taskPushNotificationConfig: undefined,
      returnImmediately,
    },
    metadata: undefined,
  };
}

export async function startCompatibilityHarness(): Promise<CompatibilityHarness> {
  const app = express();
  const server: Server = createServer(app);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The compatibility server did not bind a TCP port.");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  const card: AgentCard = {
    name: "A2A compatibility probe",
    description: "In-memory protocol transport fixture for M0 compatibility checks.",
    supportedInterfaces: [
      {
        url: `${origin}/rpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "",
      },
    ],
    provider: { organization: "M0 compatibility probe", url: "https://example.invalid" },
    version: "0.0.0-probe",
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "protocol-probe",
        name: "Protocol probe",
        description: "Exercises A2A task lifecycle and streaming transport.",
        tags: ["compatibility"],
        examples: ["Run the A2A compatibility probe."],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };

  const requests: CapturedRequest[] = [];
  const heldTasks = new Map<string, HeldTask>();

  const publishResult = (taskId: string, heldTask: HeldTask) => {
    heldTask.eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId: heldTask.contextId,
        artifact: {
          artifactId: `result-${taskId}`,
          name: "compatibility result",
          description: "A deterministic result emitted by the in-memory executor.",
          parts: [
            {
              content: {
                $case: "data",
                value: { outcome: "succeeded", source: "m0-a2a-probe" },
              },
              mediaType: "application/json",
              filename: "",
              metadata: undefined,
            },
          ],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }),
    );
    heldTask.eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: heldTask.contextId,
        status: taskStatus(TaskState.TASK_STATE_COMPLETED),
        metadata: undefined,
      }),
    );
  };

  const executor: AgentExecutor = {
    execute: async (context, eventBus) => {
      const taskId = context.taskId;
      const heldTask: HeldTask = {
        contextId: context.contextId,
        eventBus,
        release: () => undefined,
      };
      const mode = dataFromMessage(context.userMessage).mode;
      eventBus.publish(
        AgentEvent.task({
          id: taskId,
          contextId: context.contextId,
          status: taskStatus(TaskState.TASK_STATE_WORKING),
          artifacts: [],
          history: [context.userMessage],
          metadata: undefined,
        }),
      );

      if (mode === "hold") {
        await new Promise<"complete" | "cancel">((resolveGate) => {
          heldTask.release = resolveGate;
          heldTasks.set(taskId, heldTask);
        });
        heldTasks.delete(taskId);
        if (mode === "hold" && canceledTasks.has(taskId)) return;
      }
      publishResult(taskId, heldTask);
    },
    cancelTask: async (taskId, eventBus) => {
      const heldTask = heldTasks.get(taskId);
      if (!heldTask) return;
      canceledTasks.add(taskId);
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: heldTask.contextId,
          status: taskStatus(TaskState.TASK_STATE_CANCELED),
          metadata: undefined,
        }),
      );
      heldTask.release("cancel");
    },
  };
  const canceledTasks = new Set<string>();
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);

  app.get("/.well-known/agent-card.json", (_request: Request, response: ExpressResponse) => {
    response.json(card);
  });
  app.use(
    "/rpc",
    express.json(),
    (request: Request, _response: ExpressResponse, next: NextFunction) => {
      requests.push({ method: request.body?.method, version: request.header("A2A-Version") ?? null });
      next();
    },
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );

  return {
    origin,
    card,
    requests,
    complete(taskId) {
      const heldTask = heldTasks.get(taskId);
      if (!heldTask) throw new Error(`No held task exists for ${taskId}.`);
      heldTask.release("complete");
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}

export async function createSdkClient(harness: CompatibilityHarness): Promise<Client> {
  return new ClientFactory().createFromUrl(harness.origin);
}

export async function rawJsonRpc(
  harness: CompatibilityHarness,
  request: Record<string, unknown>,
  options: { version?: string | null; accept?: string } = {},
) {
  const version = options.version === undefined ? "1.0" : options.version;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (version !== null) headers["A2A-Version"] = version;
  if (options.accept) headers.Accept = options.accept;
  const response = await fetch(`${harness.origin}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

export async function rawSse(
  harness: CompatibilityHarness,
  request: Record<string, unknown>,
) {
  return fetch(`${harness.origin}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "A2A-Version": "1.0",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
}

export async function* readSseEvents(response: globalThis.Response): AsyncGenerator<Record<string, any>> {
  if (!response.body) throw new Error("The SSE response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseFrame = (frame: string): Record<string, any> | undefined => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return data ? JSON.parse(data) as Record<string, any> : undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        const event = parseFrame(buffer);
        if (event) yield event;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function rawSendRequest(messageId: string, mode: string, returnImmediately: boolean) {
  return {
    jsonrpc: "2.0",
    id: messageId,
    method: "SendMessage",
    params: rawMessage(messageId, mode, returnImmediately),
  };
}

export function rawStreamRequest(
  method: "SendStreamingMessage" | "SubscribeToTask",
  id: string,
  params: Record<string, unknown>,
) {
  return { jsonrpc: "2.0", id, method, params };
}

export function rpcBody(value: { body: unknown }) {
  if (typeof value.body !== "object" || value.body === null || Array.isArray(value.body)) {
    throw new Error("The JSON-RPC response body was not an object.");
  }
  return value.body as Record<string, any>;
}

export function getSdkVersion(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@a2a-js/sdk");
  const packageJson = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8")) as { version: string };
  return packageJson.version;
}

export async function writeRuntimeEvidence(value: unknown): Promise<string> {
  const output = new URL("../evidence/m0/a2a-runtime.json", import.meta.url);
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return fileURLToPath(output);
}
