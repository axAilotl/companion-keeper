import type {
  CleanMessage,
  ConversationModelSummary,
  JsonRecord,
  MessageOrder,
  SupportedRole,
} from "../types.js";
import { asNumber, asRecord, asString, formatDateFromUnix, sanitizeFilename } from "../utils.js";

const MODEL_KEYS = ["model_slug", "default_model_slug", "model"] as const;

export function detectOpenAiConversation(value: JsonRecord): boolean {
  return asRecord(value.mapping) !== null;
}

export function iterOpenAiMessages(conversation: JsonRecord): JsonRecord[] {
  const mapping = asRecord(conversation.mapping);
  if (!mapping) {
    return [];
  }

  const messages: JsonRecord[] = [];
  for (const node of Object.values(mapping)) {
    const nodeRecord = asRecord(node);
    if (!nodeRecord) {
      continue;
    }
    const message = asRecord(nodeRecord.message);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

export function getMessageModel(message: JsonRecord): string | null {
  const metadata = asRecord(message.metadata);
  if (!metadata) {
    return null;
  }

  for (const key of MODEL_KEYS) {
    const value = asString(metadata[key]);
    if (value && value.length > 0) {
      return value;
    }
  }

  return null;
}

export function getOpenAiConversationModels(conversation: JsonRecord): ConversationModelSummary {
  const models = new Set<string>();
  const counts = new Map<string, number>();

  for (const message of iterOpenAiMessages(conversation)) {
    const role = getMessageRole(message);
    if (role !== "assistant") {
      continue;
    }

    const model = getMessageModel(message);
    if (!model) {
      continue;
    }

    models.add(model);
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }

  return { models, counts };
}

export function firstOpenAiMessageTime(conversation: JsonRecord): number | null {
  const times: number[] = [];

  for (const message of iterOpenAiMessages(conversation)) {
    const ts = asNumber(message.create_time);
    if (ts !== null) {
      times.push(ts);
    }
  }

  if (times.length > 0) {
    return Math.min(...times);
  }

  return asNumber(conversation.create_time);
}

export function orderOpenAiMessages(
  conversation: JsonRecord,
  roles: Set<SupportedRole>,
  order: MessageOrder = "time",
): JsonRecord[] {
  if (order === "current-path") {
    return orderOpenAiMessagesByCurrentPath(conversation, roles);
  }

  const messages: JsonRecord[] = [];
  for (const message of iterOpenAiMessages(conversation)) {
    const role = getMessageRole(message);
    if (role && roles.has(role)) {
      messages.push(message);
    }
  }

  messages.sort((a, b) => {
    const at = asNumber(a.create_time);
    const bt = asNumber(b.create_time);

    const aHas = at === null ? 0 : 1;
    const bHas = bt === null ? 0 : 1;
    if (aHas !== bHas) {
      return aHas - bHas;
    }
    return (at ?? 0) - (bt ?? 0);
  });

  return messages;
}

export function cleanOpenAiMessage(
  message: JsonRecord,
  includeMetadata = false,
): CleanMessage {
  const author = asRecord(message.author);
  const content = asRecord(message.content);

  const role = asString(author?.role);
  const name = asString(author?.name);
  const contentType = asString(content?.content_type);
  const createTime = asNumber(message.create_time);

  const parts = Array.isArray(content?.parts) ? [...content.parts] : null;
  const text = extractOpenAiText(parts);
  const model = getMessageModel(message);

  const id = stringifyId(message.id);
  const cleaned: CleanMessage = {
    id,
    role,
    name,
    create_time: createTime,
    content_type: contentType,
    parts,
    text,
    model,
  };

  if (includeMetadata) {
    cleaned.metadata = asRecord(message.metadata);
  }

  return cleaned;
}

export function buildOpenAiConversationFileBase(conversation: JsonRecord): string {
  const rawId =
    asString(conversation.conversation_id) ?? asString(conversation.id) ?? "unknown-session";
  const conversationId = sanitizeFilename(rawId);
  const date = formatDateFromUnix(firstOpenAiMessageTime(conversation));
  return `${date}_${conversationId}`;
}

function orderOpenAiMessagesByCurrentPath(
  conversation: JsonRecord,
  roles: Set<SupportedRole>,
): JsonRecord[] {
  const mapping = asRecord(conversation.mapping);
  if (!mapping) {
    return [];
  }

  const ordered: JsonRecord[] = [];
  const visited = new Set<string>();
  let nodeId = asString(conversation.current_node);

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = asRecord(mapping[nodeId]);
    if (!node) {
      break;
    }

    const message = asRecord(node.message);
    if (message) {
      const role = getMessageRole(message);
      if (role && roles.has(role)) {
        ordered.push(message);
      }
    }

    nodeId = asString(node.parent);
  }

  ordered.reverse();
  return ordered;
}

function getMessageRole(message: JsonRecord): SupportedRole | null {
  const author = asRecord(message.author);
  const role = asString(author?.role);
  if (role === "system" || role === "user" || role === "assistant") {
    return role;
  }
  return null;
}

function extractOpenAiText(parts: unknown[] | null): string | null {
  if (!parts || parts.length === 0) {
    return null;
  }

  for (const part of parts) {
    if (typeof part !== "string") {
      return null;
    }
  }

  return (parts as string[]).join("");
}

function stringifyId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}
