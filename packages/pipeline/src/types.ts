export type ExportFormat = "openai" | "anthropic" | "unknown";

export type SupportedRole = "system" | "user" | "assistant";

export type MessageOrder = "time" | "current-path";

export type OutputFormat = "jsonl" | "json";

export type JsonRecord = Record<string, unknown>;

export interface CleanMessage {
  id: string | null;
  role: string | null;
  name: string | null;
  create_time: number | null;
  content_type: string | null;
  parts: unknown[] | null;
  text: string | null;
  model: string | null;
  metadata?: JsonRecord | null;
}

export interface ConversationModelSummary {
  models: Set<string>;
  counts: Map<string, number>;
}

export interface DiscoverModelsResult {
  format: ExportFormat;
  totalConversations: number;
  messageCounts: Record<string, number>;
  conversationCounts: Record<string, number>;
}

export interface AnalyzeStructureResult {
  format: ExportFormat;
  sampleSize: number;
  topLevelKeys: string[];
  mappingNodeKeys: string[];
  messageKeys: string[];
  authorKeys: string[];
  contentKeys: string[];
  metadataKeysSample: string[];
  contentTypesSample: Record<string, number>;
  rolesSample: Record<string, number>;
}

export interface ExtractOptions {
  inputPath: string;
  models: string[];
  outputDir?: string;
  format?: OutputFormat;
  roles?: SupportedRole[];
  order?: MessageOrder;
  includeRaw?: boolean;
  includeMetadata?: boolean;
  maxConversations?: number;
  onProgress?: (message: string) => void;
}

export interface ExtractResult {
  format: ExportFormat;
  extracted: number;
  outputDir: string;
}

export interface ResolvedInput {
  kind: "json" | "zip";
  inputPath: string;
}

export interface RoleContentMessage {
  role: SupportedRole;
  content: string;
}

export interface ConversationPacket {
  conversationId: string;
  sourceFile?: string;
  transcript: string;
  messagesUsed: number;
  charCount: number;
}

export interface PersonaExtractionPayload {
  companionName: string;
  sourceLabel: string;
  transcript: string;
  conversationPackets: ConversationPacket[];
  metadata: {
    conversationCount: number;
    totalChars: number;
  };
}

export interface MemoryExtractionPayload {
  companionName: string;
  maxMemories: number;
  candidateMemories: MemoryCandidate[];
  transcriptPackets: ConversationPacket[];
}

export interface MemoryCandidate {
  name: string;
  keys: string[];
  content: string;
  category?: string;
  priority?: number;
  sourceConversation?: string;
  sourceDate?: string;
}

export interface LorebookEntry {
  name: string;
  keys: string[];
  content: string;
  category: string;
  priority: number;
  sourceConversation?: string;
  sourceDate?: string;
}

export interface LorebookV3 {
  name: string;
  description: string;
  entries: LorebookEntry[];
}

export interface CharacterCardV3Draft {
  spec: "chara_card_v3";
  spec_version: "3.0";
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    creator_notes: string;
    tags: string[];
    system_prompt: string;
    post_history_instructions: string;
  };
}
