import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export interface StreamArrayOptions {
  readChunkBytes?: number;
}

export async function* streamJsonArrayObjectsFromFile(
  filePath: string,
  options: StreamArrayOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(filePath, {
    highWaterMark: options.readChunkBytes ?? DEFAULT_CHUNK_BYTES,
  });

  try {
    for await (const value of streamJsonArrayObjectsFromReadable(stream)) {
      yield value;
    }
  } finally {
    stream.destroy();
  }
}

export async function* streamJsonArrayObjectsFromReadable(
  readable: Readable,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let index = 0;
  let started = false;
  let finished = false;

  let capturing = false;
  let tokenStart = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  const flushParsed = (isFinal: boolean): Record<string, unknown>[] => {
    const parsed: Record<string, unknown>[] = [];

    while (index < buffer.length) {
      const ch = buffer[index];
      if (ch === undefined) {
        break;
      }

      if (!started) {
        if (isWhitespace(ch)) {
          index += 1;
          continue;
        }
        if (ch !== "[") {
          throw new Error(`Expected '[' at top level, got '${ch}'`);
        }
        started = true;
        index += 1;
        continue;
      }

      if (finished) {
        if (!isWhitespace(ch)) {
          throw new Error("Unexpected non-whitespace content after closing JSON array");
        }
        index += 1;
        continue;
      }

      if (!capturing) {
        if (isWhitespace(ch) || ch === ",") {
          index += 1;
          continue;
        }

        if (ch === "]") {
          finished = true;
          index += 1;
          continue;
        }

        if (ch !== "{" && ch !== "[") {
          throw new Error(`Expected JSON object item at array level, got '${ch}'`);
        }

        capturing = true;
        tokenStart = index;
        depth = 1;
        inString = false;
        escaped = false;
        index += 1;
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        index += 1;
        continue;
      }

      if (ch === '"') {
        inString = true;
        index += 1;
        continue;
      }

      if (ch === "{" || ch === "[") {
        depth += 1;
      } else if (ch === "}" || ch === "]") {
        depth -= 1;
      }

      if (depth === 0) {
        const jsonText = buffer.slice(tokenStart, index + 1);
        const item = JSON.parse(jsonText);
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("Top-level array item is not an object");
        }

        parsed.push(item as Record<string, unknown>);

        buffer = buffer.slice(index + 1);
        index = 0;
        capturing = false;
        tokenStart = 0;
        continue;
      }

      index += 1;
    }

    if (capturing && tokenStart > 0) {
      buffer = buffer.slice(tokenStart);
      index -= tokenStart;
      tokenStart = 0;
    } else if (!capturing && index > 0) {
      buffer = buffer.slice(index);
      index = 0;
    }

    if (isFinal) {
      if (!started) {
        throw new Error("Input is not a JSON array");
      }
      if (capturing) {
        throw new Error("Unexpected EOF while parsing JSON object");
      }
      if (!finished) {
        throw new Error("Unexpected EOF while parsing top-level JSON array");
      }
    }

    return parsed;
  };

  for await (const rawChunk of readable) {
    const chunk =
      typeof rawChunk === "string"
        ? rawChunk
        : decoder.write(Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk));

    if (chunk.length === 0) {
      continue;
    }

    buffer += chunk;
    for (const obj of flushParsed(false)) {
      yield obj;
    }
  }

  buffer += decoder.end();
  for (const obj of flushParsed(true)) {
    yield obj;
  }
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}
