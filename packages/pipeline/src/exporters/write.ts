import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import type { JsonRecord, MessageOrder, OutputFormat, SupportedRole } from "../types.js";
import { uniquePath, sanitizeFilename } from "../utils.js";
import {
  buildAnthropicConversationFileBase,
  orderAnthropicMessages,
  anthropicConversationTimestamp,
} from "./anthropic.js";
import {
  buildOpenAiConversationFileBase,
  cleanOpenAiMessage,
  orderOpenAiMessages,
} from "./openai.js";

export interface WriteOpenAiOptions {
  outputDir: string;
  modelDir: string;
  format: OutputFormat;
  roles: Set<SupportedRole>;
  order: MessageOrder;
  includeRaw: boolean;
  includeMetadata: boolean;
}

export interface WriteAnthropicOptions {
  outputDir: string;
  modelDir: string;
  format: OutputFormat;
  roles: Set<SupportedRole>;
}

export async function writeOpenAiConversation(
  conversation: JsonRecord,
  options: WriteOpenAiOptions,
): Promise<string> {
  const filePath = await buildUniqueOutputPath(
    options.outputDir,
    options.modelDir,
    buildOpenAiConversationFileBase(conversation),
    options.format,
  );

  const orderedMessages = orderOpenAiMessages(conversation, options.roles, options.order);

  if (options.format === "json") {
    const items = orderedMessages.map((message) => {
      if (options.includeRaw) {
        return message;
      }
      return cleanOpenAiMessage(message, options.includeMetadata);
    });

    const payload = {
      conversation_id:
        typeof conversation.conversation_id === "string" ? conversation.conversation_id : null,
      title: typeof conversation.title === "string" ? conversation.title : null,
      create_time:
        typeof conversation.create_time === "number" ? conversation.create_time : null,
      update_time:
        typeof conversation.update_time === "number" ? conversation.update_time : null,
      messages: items,
    };

    await writeFile(filePath, JSON.stringify(payload), "utf8");
    return filePath;
  }

  const rows = orderedMessages.map((message) => {
    if (options.includeRaw) {
      return message;
    }
    return cleanOpenAiMessage(message, options.includeMetadata);
  });

  await writeJsonl(filePath, rows);
  return filePath;
}

export async function writeAnthropicConversation(
  conversation: JsonRecord,
  options: WriteAnthropicOptions,
): Promise<string> {
  const filePath = await buildUniqueOutputPath(
    options.outputDir,
    options.modelDir,
    buildAnthropicConversationFileBase(conversation),
    options.format,
  );

  const messages = orderAnthropicMessages(conversation, options.roles);

  if (options.format === "json") {
    const payload = {
      conversation_id: typeof conversation.uuid === "string" ? conversation.uuid : null,
      title: typeof conversation.name === "string" ? conversation.name : null,
      create_time: anthropicConversationTimestamp(conversation),
      update_time: null,
      messages,
    };
    await writeFile(filePath, JSON.stringify(payload), "utf8");
    return filePath;
  }

  await writeJsonl(filePath, messages);
  return filePath;
}

async function buildUniqueOutputPath(
  outputDir: string,
  modelDir: string,
  fileBaseName: string,
  format: OutputFormat,
): Promise<string> {
  const ext = format === "json" ? ".json" : ".jsonl";
  const modelTag = sanitizeFilename(modelDir);
  const targetDir = path.join(outputDir, modelTag);
  await mkdir(targetDir, { recursive: true });
  const basePath = path.join(targetDir, `${modelTag}_${fileBaseName}${ext}`);
  return uniquePath(basePath);
}

async function writeJsonl(filePath: string, items: unknown[]): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });

  try {
    for (const item of items) {
      const line = `${JSON.stringify(item)}\n`;
      if (!stream.write(line)) {
        await once(stream, "drain");
      }
    }
  } finally {
    stream.end();
    await once(stream, "finish");
  }
}
