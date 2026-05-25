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

      const text = extractText(raw);

      if (text) {
        output += text;
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

  for (const value of Object.values(record)) {
    const nested = extractText(value, depth + 1);

    if (nested) {
      return nested;
    }
  }

  return "";
}
