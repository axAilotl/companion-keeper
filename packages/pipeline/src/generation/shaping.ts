import type {
  CharacterCardV3Draft,
  LorebookEntry,
  LorebookV3,
  MemoryCandidate,
} from "../types.js";
import { normalizeNewlines } from "../utils.js";

export interface LorebookShapeOptions {
  name?: string;
  description?: string;
  maxEntries?: number;
}

export interface CardShapeInput {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  messageExample?: string;
  creatorNotes?: string;
  tags?: string[];
  systemPrompt?: string;
  postHistoryInstructions?: string;
}

export function compactMemoryCandidates(
  candidates: MemoryCandidate[],
  maxEntries = 150,
): LorebookEntry[] {
  const out: LorebookEntry[] = [];

  for (const candidate of candidates) {
    const content = safeMultiline(candidate.content).trim();
    const keys = normalizeKeys(candidate.keys);

    if (content.length === 0 || keys.length === 0) {
      continue;
    }

    const priority = toPriority(candidate.priority);
    const signature = `${normalizeForDedup(content)}|${keys.join("|")}`;

    const existing = out.find((entry) => {
      const currentSignature = `${normalizeForDedup(entry.content)}|${normalizeKeys(entry.keys).join("|")}`;
      return currentSignature === signature;
    });

    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      existing.keys = normalizeKeys([...existing.keys, ...keys]);
      if (content.length > existing.content.length) {
        existing.content = content;
      }
      if (!existing.sourceConversation && candidate.sourceConversation) {
        existing.sourceConversation = candidate.sourceConversation;
      }
      if (!existing.sourceDate && candidate.sourceDate) {
        existing.sourceDate = candidate.sourceDate;
      }
      continue;
    }

    const entry: LorebookEntry = {
      name: safeSingleLine(candidate.name) || "Memory",
      keys,
      content,
      category: safeSingleLine(candidate.category) || "shared_memory",
      priority,
    };

    if (candidate.sourceConversation) {
      entry.sourceConversation = candidate.sourceConversation;
    }
    if (candidate.sourceDate) {
      entry.sourceDate = candidate.sourceDate;
    }

    out.push(entry);

    if (maxEntries > 0 && out.length >= maxEntries) {
      break;
    }
  }

  return out;
}

export function shapeLorebookV3(
  companionName: string,
  candidates: MemoryCandidate[],
  options: LorebookShapeOptions = {},
): LorebookV3 {
  const entries = compactMemoryCandidates(candidates, options.maxEntries ?? 150);

  return {
    name: options.name ?? `${companionName} Memory Lorebook`,
    description:
      options.description ??
      `High-signal shared memories extracted for ${companionName}.`,
    entries,
  };
}

export function shapeCharacterCardV3Draft(input: CardShapeInput): CharacterCardV3Draft {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: safeSingleLine(input.name) || "Companion",
      description: safeMultiline(input.description),
      personality: safeMultiline(input.personality),
      scenario: safeMultiline(input.scenario),
      first_mes: safeMultiline(input.firstMessage),
      mes_example: safeMultiline(input.messageExample),
      creator_notes: safeMultiline(input.creatorNotes),
      tags: normalizeTagList(input.tags),
      system_prompt: safeMultiline(input.systemPrompt),
      post_history_instructions: safeMultiline(input.postHistoryInstructions),
    },
  };
}

function safeMultiline(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return normalizeNewlines(value).replace(/\u0000/g, "");
}

function safeSingleLine(value: unknown): string {
  return safeMultiline(value).replace(/\n+/g, " ").trim();
}

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const key = safeSingleLine(item);
    if (key.length === 0) {
      continue;
    }

    const normalized = key.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(key);
  }

  return out;
}

function normalizeForDedup(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const tag = safeSingleLine(item);
    if (tag.length > 0) {
      out.push(tag);
    }
  }
  return out;
}

function toPriority(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}
