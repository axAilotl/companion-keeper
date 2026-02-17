import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type {
  ConversationPacket,
  JsonRecord,
  MemoryCandidate,
  MemoryExtractionPayload,
  PersonaExtractionPayload,
  RoleContentMessage,
  SupportedRole,
} from "../types.js";
import { normalizeNewlines } from "../utils.js";

const ROLE_SET = new Set<SupportedRole>(["system", "user", "assistant"]);

export interface PacketBuildOptions {
  maxMessagesPerConversation?: number;
  maxCharsPerConversation?: number;
}

export function newlineSafeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return normalizeNewlines(value);
}

export function buildConversationPacket(
  conversationId: string,
  messages: RoleContentMessage[],
  options: PacketBuildOptions = {},
): ConversationPacket {
  const maxMessages = options.maxMessagesPerConversation ?? 0;
  const maxChars = options.maxCharsPerConversation ?? 0;

  const lines: string[] = [];
  let charCount = 0;
  let used = 0;

  for (const message of messages) {
    if (maxMessages > 0 && used >= maxMessages) {
      break;
    }

    const content = newlineSafeText(message.content);
    if (content.length === 0) {
      continue;
    }

    const line = `[${message.role}] ${content}`;
    if (maxChars > 0 && charCount + line.length > maxChars) {
      break;
    }

    lines.push(line);
    charCount += line.length;
    used += 1;
  }

  return {
    conversationId,
    transcript: lines.join("\n"),
    messagesUsed: used,
    charCount,
  };
}

export async function readExtractedConversationFile(filePath: string): Promise<RoleContentMessage[]> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const out: RoleContentMessage[] = [];

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const message = toRecord(raw);
      if (!message) {
        continue;
      }

      const role = typeof message.role === "string" ? message.role : null;
      if (!role || !ROLE_SET.has(role as SupportedRole)) {
        continue;
      }

      let content = newlineSafeText(message.text);
      if (content.length === 0) {
        content = newlineSafeText(joinStringParts(message.parts));
      }

      if (content.length === 0) {
        continue;
      }

      out.push({ role: role as SupportedRole, content });
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return out;
}

export async function buildConversationPacketFromFile(
  filePath: string,
  options: PacketBuildOptions = {},
): Promise<ConversationPacket> {
  const messages = await readExtractedConversationFile(filePath);
  const packet = buildConversationPacket(conversationIdFromFile(filePath), messages, options);
  packet.sourceFile = path.basename(filePath);
  return packet;
}

export async function buildConversationPacketsFromDir(
  inputDir: string,
  options: PacketBuildOptions = {},
): Promise<ConversationPacket[]> {
  const names = await readdir(inputDir, { withFileTypes: true });
  const files = names
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const packets: ConversationPacket[] = [];
  for (const name of files) {
    const filePath = path.join(inputDir, name);
    const packet = await buildConversationPacketFromFile(filePath, options);
    if (packet.messagesUsed === 0) {
      continue;
    }
    packets.push(packet);
  }

  return packets;
}

export function buildPersonaExtractionPayload(
  companionName: string,
  packets: ConversationPacket[],
  sourceLabel = "openai_export",
): PersonaExtractionPayload {
  const transcriptSections = packets.map((packet) => {
    return `=== conversation: ${packet.conversationId} ===\n${packet.transcript}`;
  });

  const totalChars = packets.reduce((sum, packet) => sum + packet.charCount, 0);

  return {
    companionName,
    sourceLabel,
    transcript: transcriptSections.join("\n\n"),
    conversationPackets: packets,
    metadata: {
      conversationCount: packets.length,
      totalChars,
    },
  };
}

export function buildMemoryExtractionPayload(
  companionName: string,
  packets: ConversationPacket[],
  candidateMemories: MemoryCandidate[],
  maxMemories: number,
): MemoryExtractionPayload {
  return {
    companionName,
    maxMemories,
    candidateMemories,
    transcriptPackets: packets,
  };
}

function joinStringParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }

  let out = "";
  for (const part of parts) {
    if (typeof part === "string") {
      out += part;
    }
  }
  return out;
}

function toRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function conversationIdFromFile(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}
