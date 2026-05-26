import type { HarnessEvent, ProviderId } from "./types.js";

export type EmitHarnessEvent = (event: HarnessEvent) => void;

export interface StreamParser {
  onStdout(chunk: string, emit: EmitHarnessEvent): void;
  flush(emit: EmitHarnessEvent): void;
  text(): string;
}

export function createTextStreamParser(provider: ProviderId): StreamParser {
  let output = "";

  return {
    onStdout(chunk, emit) {
      output += chunk;
      emit({
        type: "chunk",
        provider,
        data: chunk,
        text: chunk
      });
    },
    flush() {},
    text() {
      return output.trim();
    }
  };
}

export function createJsonlStreamParser(provider: ProviderId): StreamParser {
  let buffer = "";
  let output = "";
  let emittedText = false;

  const parseLine = (line: string, emit: EmitHarnessEvent) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    try {
      const raw = JSON.parse(trimmed) as unknown;
      emit({
        type: "raw",
        provider,
        data: trimmed,
        raw
      });

      const text = extractProviderText(provider, raw, emittedText);

      if (text) {
        output += text;
        emittedText = true;
        emit({
          type: "chunk",
          provider,
          data: text,
          text,
          raw
        });
      }
    } catch (error) {
      emit({
        type: "raw",
        provider,
        data: trimmed,
        error: error instanceof Error ? error : undefined,
        message: "Unable to parse provider JSONL event."
      });
    }
  };

  return {
    onStdout(chunk, emit) {
      buffer += chunk;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        parseLine(line, emit);
      }
    },
    flush(emit) {
      parseLine(buffer, emit);
      buffer = "";
    },
    text() {
      return output.trim();
    }
  };
}

function extractProviderText(provider: ProviderId, value: unknown, emittedText: boolean): string {
  if (provider === "claude") {
    return extractClaudeText(value, emittedText);
  }

  if (provider === "codex") {
    return extractCodexText(value);
  }

  if (provider === "copilot") {
    return extractCopilotText(value, emittedText);
  }

  if (provider === "wp-studio") {
    return extractWpStudioText(value, emittedText);
  }

  return extractGeminiText(value, emittedText);
}

function extractClaudeText(value: unknown, emittedText: boolean): string {
  const record = asRecord(value);

  if (!record) {
    return "";
  }

  if (record.type === "stream_event") {
    const event = asRecord(record.event);

    if (!event) {
      return "";
    }

    if (event.type === "content_block_delta") {
      return stringFromPath(event, ["delta", "text"]);
    }

    if (event.type === "content_block_start") {
      return stringFromPath(event, ["content_block", "text"]);
    }

    return "";
  }

  if (emittedText) {
    return "";
  }

  if (record.type === "assistant") {
    return contentText(asRecord(record.message)?.content);
  }

  if (record.type === "result" && typeof record.result === "string") {
    return record.result;
  }

  return "";
}

function extractCodexText(value: unknown): string {
  const record = asRecord(value);

  if (!record) {
    return "";
  }

  if (record.type === "item.completed") {
    const item = asRecord(record.item);

    if (item?.type === "agent_message" && typeof item.text === "string") {
      return item.text;
    }
  }

  if (record.type === "agent_message.delta") {
    return stringFromPath(record, ["delta", "text"]);
  }

  return "";
}

function extractCopilotText(value: unknown, emittedText: boolean): string {
  const record = asRecord(value);

  if (!record) {
    return "";
  }

  if (record.type === "assistant.message_delta") {
    return stringFromPath(record, ["data", "deltaContent"]);
  }

  if (!emittedText && record.type === "assistant.message") {
    return stringFromPath(record, ["data", "content"]);
  }

  return "";
}

function extractGeminiText(value: unknown, emittedText: boolean): string {
  const record = asRecord(value);

  if (!record || record.type !== "message" || record.role !== "assistant") {
    return "";
  }

  if (record.delta === true || !emittedText) {
    return contentText(record.content);
  }

  return "";
}

function extractWpStudioText(value: unknown, emittedText: boolean): string {
  const record = asRecord(value);

  if (!record || record.type !== "message") {
    return "";
  }

  const message = asRecord(record.message);

  if (!message) {
    return "";
  }

  if (message.type === "message_update") {
    const event = asRecord(message.assistantMessageEvent);

    if (event?.type === "text_delta" && typeof event.delta === "string") {
      return event.delta;
    }

    if (!emittedText && event?.type === "text_end" && typeof event.content === "string") {
      return event.content;
    }

    return "";
  }

  if (emittedText) {
    return "";
  }

  if (message.type === "message_end" || message.type === "turn_end") {
    return assistantMessageText(message.message);
  }

  if (message.type === "agent_end" && Array.isArray(message.messages)) {
    const assistant = [...message.messages]
      .reverse()
      .map((item) => asRecord(item))
      .find((item) => item?.role === "assistant");

    return contentText(assistant?.content);
  }

  return "";
}

function assistantMessageText(value: unknown): string {
  const message = asRecord(value);

  if (message?.role !== "assistant") {
    return "";
  }

  return contentText(message.content);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringFromPath(value: unknown, path: string[]): string {
  let current = value;

  for (const key of path) {
    const record = asRecord(current);

    if (!record) {
      return "";
    }

    current = record[key];
  }

  return typeof current === "string" ? current : "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      const record = asRecord(item);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join("");
}

export function extractText(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractText(item, depth + 1)).join("");
  }

  const record = value as Record<string, unknown>;

  if (record.type === "result" && typeof record.result === "string") {
    return "";
  }

  const directKeys = ["delta", "text", "response", "result", "output"];

  for (const key of directKeys) {
    const direct = record[key];

    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
  }

  const content = record.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const contentText = content.map((item) => extractText(item, depth + 1)).join("");

    if (contentText) {
      return contentText;
    }
  }

  const message = record.message;

  if (message && typeof message === "object") {
    const messageText = extractText(message, depth + 1);

    if (messageText) {
      return messageText;
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (["id", "type", "role", "name", "timestamp", "session_id", "thread_id"].includes(key)) {
      continue;
    }

    const nested = extractText(value, depth + 1);

    if (nested) {
      return nested;
    }
  }

  return "";
}
