import type {
  AnalyzeStructureResult,
  DiscoverModelsResult,
  ExportFormat,
  ExtractOptions,
  ExtractResult,
  JsonRecord,
  SupportedRole,
} from "./types.js";
import { openInputStream } from "./io/input.js";
import { streamJsonArrayObjectsFromReadable } from "./io/jsonArrayStream.js";
import { counterIncrement, mapToSortedRecord } from "./utils.js";
import { detectAnthropicConversation, anthropicMessageCount } from "./exporters/anthropic.js";
import { detectOpenAiConversation, getOpenAiConversationModels } from "./exporters/openai.js";
import { writeAnthropicConversation, writeOpenAiConversation } from "./exporters/write.js";

export async function analyzeStructure(
  inputPath: string,
  sample = 3,
): Promise<AnalyzeStructureResult> {
  const topLevelKeys = new Set<string>();
  const mappingNodeKeys = new Set<string>();
  const messageKeys = new Set<string>();
  const authorKeys = new Set<string>();
  const contentKeys = new Set<string>();
  const metadataKeys = new Set<string>();
  const contentTypeCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();

  let count = 0;
  let format: ExportFormat = "unknown";

  for await (const conversation of iterConversations(inputPath)) {
    count += 1;

    for (const key of Object.keys(conversation)) {
      topLevelKeys.add(key);
    }

    const detected = detectConversationFormat(conversation);
    if (format === "unknown" && detected !== "unknown") {
      format = detected;
    }

    if (detected === "openai") {
      const mapping = toRecord(conversation.mapping);
      if (mapping) {
        for (const nodeValue of Object.values(mapping)) {
          const node = toRecord(nodeValue);
          if (!node) {
            continue;
          }

          for (const key of Object.keys(node)) {
            mappingNodeKeys.add(key);
          }

          const message = toRecord(node.message);
          if (!message) {
            continue;
          }

          for (const key of Object.keys(message)) {
            messageKeys.add(key);
          }

          const author = toRecord(message.author);
          if (author) {
            for (const key of Object.keys(author)) {
              authorKeys.add(key);
            }
            const role = typeof author.role === "string" ? author.role : null;
            if (role) {
              counterIncrement(roleCounts, role);
            }
          }

          const content = toRecord(message.content);
          if (content) {
            for (const key of Object.keys(content)) {
              contentKeys.add(key);
            }
            const contentType = typeof content.content_type === "string" ? content.content_type : null;
            if (contentType) {
              counterIncrement(contentTypeCounts, contentType);
            }
          }

          const metadata = toRecord(message.metadata);
          if (metadata) {
            for (const key of Object.keys(metadata)) {
              metadataKeys.add(key);
            }
          }
        }
      }
    } else if (detected === "anthropic") {
      const chatMessages = Array.isArray(conversation.chat_messages)
        ? conversation.chat_messages
        : [];
      for (const messageValue of chatMessages) {
        const message = toRecord(messageValue);
        if (!message) {
          continue;
        }
        for (const key of Object.keys(message)) {
          messageKeys.add(key);
        }
        const sender = typeof message.sender === "string" ? message.sender : null;
        if (sender) {
          counterIncrement(roleCounts, sender);
        }
      }
    }

    if (count >= sample) {
      break;
    }
  }

  return {
    format,
    sampleSize: count,
    topLevelKeys: [...topLevelKeys].sort(),
    mappingNodeKeys: [...mappingNodeKeys].sort(),
    messageKeys: [...messageKeys].sort(),
    authorKeys: [...authorKeys].sort(),
    contentKeys: [...contentKeys].sort(),
    metadataKeysSample: [...metadataKeys].sort(),
    contentTypesSample: mapToSortedRecord(contentTypeCounts),
    rolesSample: mapToSortedRecord(roleCounts),
  };
}

export async function detectExportFormat(inputPath: string): Promise<ExportFormat> {
  for await (const conversation of iterConversations(inputPath)) {
    return detectConversationFormat(conversation);
  }
  return "unknown";
}

export async function discoverModels(inputPath: string): Promise<DiscoverModelsResult> {
  const messageCounts = new Map<string, number>();
  const conversationCounts = new Map<string, number>();

  let format: ExportFormat = "unknown";
  let totalConversations = 0;

  for await (const conversation of iterConversations(inputPath)) {
    totalConversations += 1;
    const detected = detectConversationFormat(conversation);

    if (format === "unknown" && detected !== "unknown") {
      format = detected;
    }

    if (detected === "openai") {
      const summary = getOpenAiConversationModels(conversation);
      for (const [model, count] of summary.counts.entries()) {
        counterIncrement(messageCounts, model, count);
      }
      for (const model of summary.models) {
        counterIncrement(conversationCounts, model, 1);
      }
      continue;
    }

    if (detected === "anthropic") {
      counterIncrement(messageCounts, "claude", anthropicMessageCount(conversation));
      counterIncrement(conversationCounts, "claude", 1);
    }
  }

  return {
    format,
    totalConversations,
    messageCounts: mapToSortedRecord(messageCounts),
    conversationCounts: mapToSortedRecord(conversationCounts),
  };
}

export async function extractByModels(options: ExtractOptions): Promise<ExtractResult> {
  const outputDir = options.outputDir ?? "model_exports";
  const format = options.format ?? "jsonl";
  const roles = new Set<SupportedRole>(options.roles ?? ["system", "user", "assistant"]);
  const order = options.order ?? "time";
  const includeRaw = options.includeRaw ?? false;
  const includeMetadata = options.includeMetadata ?? false;
  const maxConversations = options.maxConversations ?? 0;
  const onProgress = options.onProgress;

  const modelsSet = new Set(options.models.filter((item) => item.trim().length > 0));
  let exportFormat: ExportFormat = "unknown";
  let extracted = 0;

  for await (const conversation of iterConversations(options.inputPath)) {
    const detected = detectConversationFormat(conversation);

    if (exportFormat === "unknown" && detected !== "unknown") {
      exportFormat = detected;
    }

    if (detected === "anthropic") {
      await writeAnthropicConversation(conversation, {
        outputDir,
        modelDir: "claude",
        format,
        roles: new Set<SupportedRole>(["user", "assistant"]),
      });
      extracted += 1;
      onProgress?.(`Extracted ${extracted} conversations...`);
      if (maxConversations > 0 && extracted >= maxConversations) {
        break;
      }
      continue;
    }

    if (detected !== "openai") {
      continue;
    }

    if (modelsSet.size === 0) {
      throw new Error(
        "No models provided for OpenAI extraction. Discover models first and pass --models.",
      );
    }

    const summary = getOpenAiConversationModels(conversation);
    const matchedModels = [...summary.models].filter((model) => modelsSet.has(model));
    if (matchedModels.length === 0) {
      continue;
    }

    const primaryModel = choosePrimaryModel(matchedModels, summary.counts);

    await writeOpenAiConversation(conversation, {
      outputDir,
      modelDir: primaryModel,
      format,
      roles,
      order,
      includeRaw,
      includeMetadata,
    });

    extracted += 1;
    onProgress?.(`Extracted ${extracted} conversations...`);

    if (maxConversations > 0 && extracted >= maxConversations) {
      break;
    }
  }

  return {
    format: exportFormat,
    extracted,
    outputDir,
  };
}

export function choosePrimaryModel(models: string[], counts: Map<string, number>): string {
  const first = models[0];
  if (!first) {
    throw new Error("Cannot choose primary model from an empty list");
  }

  let best = first;
  let bestCount = counts.get(best) ?? 0;

  for (const model of models.slice(1)) {
    const count = counts.get(model) ?? 0;
    if (count > bestCount) {
      best = model;
      bestCount = count;
      continue;
    }
    if (count === bestCount && model.localeCompare(best) > 0) {
      best = model;
      bestCount = count;
    }
  }

  return best;
}

function detectConversationFormat(conversation: JsonRecord): ExportFormat {
  if (detectOpenAiConversation(conversation)) {
    return "openai";
  }
  if (detectAnthropicConversation(conversation)) {
    return "anthropic";
  }
  return "unknown";
}

async function* iterConversations(inputPath: string): AsyncGenerator<JsonRecord> {
  const { stream } = await openInputStream(inputPath);

  try {
    for await (const obj of streamJsonArrayObjectsFromReadable(stream)) {
      yield obj;
    }
  } finally {
    stream.destroy();
  }
}

function toRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
