import type { CleanMessage, JsonRecord, SupportedRole } from "../types.js";
import {
  asNumber,
  asRecord,
  asString,
  formatDateFromUnix,
  parseIsoTimestamp,
  sanitizeFilename,
} from "../utils.js";

const ANTHROPIC_SENDER_MAP: Record<string, SupportedRole | null> = {
  human: "user",
  assistant: "assistant",
};

export function detectAnthropicConversation(value: JsonRecord): boolean {
  return Array.isArray(value.chat_messages);
}

export function iterAnthropicMessages(conversation: JsonRecord): JsonRecord[] {
  const raw = conversation.chat_messages;
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: JsonRecord[] = [];
  for (const item of raw) {
    const message = asRecord(item);
    if (message) {
      out.push(message);
    }
  }
  return out;
}

export function firstAnthropicMessageTime(conversation: JsonRecord): number | null {
  const times: number[] = [];

  for (const message of iterAnthropicMessages(conversation)) {
    const ts = parseIsoTimestamp(message.created_at);
    if (ts !== null) {
      times.push(ts);
    }
  }

  if (times.length > 0) {
    return Math.min(...times);
  }

  return parseIsoTimestamp(conversation.created_at);
}

export function orderAnthropicMessages(
  conversation: JsonRecord,
  roles: Set<SupportedRole>,
): CleanMessage[] {
  const cleaned: CleanMessage[] = [];

  for (const message of iterAnthropicMessages(conversation)) {
    const normalized = cleanAnthropicMessage(message);
    if (normalized.role && roles.has(normalized.role as SupportedRole)) {
      cleaned.push(normalized);
    }
  }

  cleaned.sort((a, b) => {
    const aTime = typeof a.create_time === "number" ? a.create_time : null;
    const bTime = typeof b.create_time === "number" ? b.create_time : null;
    const aHas = aTime === null ? 0 : 1;
    const bHas = bTime === null ? 0 : 1;
    if (aHas !== bHas) {
      return aHas - bHas;
    }
    return (aTime ?? 0) - (bTime ?? 0);
  });

  return cleaned;
}

export function cleanAnthropicMessage(message: JsonRecord): CleanMessage {
  const sender = asString(message.sender) ?? "";
  const mappedRole = ANTHROPIC_SENDER_MAP[sender] ?? sender;
  const role = mappedRole.length > 0 ? mappedRole : null;

  const contentBlocks = Array.isArray(message.content) ? message.content : null;
  let text: string | null = null;

  if (contentBlocks) {
    const textParts: string[] = [];
    for (const block of contentBlocks) {
      const blockRecord = asRecord(block);
      if (!blockRecord) {
        continue;
      }
      if (asString(blockRecord.type) !== "text") {
        continue;
      }
      const blockText = asString(blockRecord.text);
      if (blockText !== null) {
        textParts.push(blockText);
      }
    }

    if (textParts.length > 0) {
      text = textParts.join("");
    }
  }

  if (text === null) {
    text = asString(message.text);
  }

  const createdAt = parseIsoTimestamp(message.created_at);

  return {
    id: asString(message.uuid),
    role,
    name: null,
    create_time: createdAt,
    content_type: "text",
    parts: text !== null ? [text] : [],
    text,
    model: null,
  };
}

export function buildAnthropicConversationFileBase(conversation: JsonRecord): string {
  const rawId =
    asString(conversation.uuid) ?? asString(conversation.name) ?? "unknown-session";
  const conversationId = sanitizeFilename(rawId);
  const date = formatDateFromUnix(firstAnthropicMessageTime(conversation));
  return `${date}_${conversationId}`;
}

export function anthropicMessageCount(conversation: JsonRecord): number {
  return iterAnthropicMessages(conversation).length;
}

export function anthropicConversationTimestamp(conversation: JsonRecord): number | null {
  const ts = parseIsoTimestamp(conversation.created_at);
  if (ts !== null) {
    return ts;
  }
  return asNumber(conversation.create_time);
}
