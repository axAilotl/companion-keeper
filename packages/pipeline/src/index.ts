export {
  analyzeStructure,
  detectExportFormat,
  discoverModels,
  extractByModels,
  choosePrimaryModel,
} from "./extraction.js";

export {
  streamJsonArrayObjectsFromFile,
  streamJsonArrayObjectsFromReadable,
} from "./io/jsonArrayStream.js";

export { openInputStream, resolveInputPath, isZipPath } from "./io/input.js";

export {
  buildConversationPacket,
  buildConversationPacketFromFile,
  buildConversationPacketsFromDir,
  buildMemoryExtractionPayload,
  buildPersonaExtractionPayload,
  newlineSafeText,
  readExtractedConversationFile,
} from "./generation/payloads.js";

export {
  compactMemoryCandidates,
  shapeCharacterCardV3Draft,
  shapeLorebookV3,
} from "./generation/shaping.js";

export type {
  AnalyzeStructureResult,
  CharacterCardV3Draft,
  CleanMessage,
  ConversationModelSummary,
  ConversationPacket,
  DiscoverModelsResult,
  ExportFormat,
  ExtractOptions,
  ExtractResult,
  JsonRecord,
  LorebookEntry,
  LorebookV3,
  MemoryCandidate,
  MemoryExtractionPayload,
  MessageOrder,
  OutputFormat,
  PersonaExtractionPayload,
  ResolvedInput,
  RoleContentMessage,
  SupportedRole,
} from "./types.js";
