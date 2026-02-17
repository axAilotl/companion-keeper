import { setTimeout as delay } from "node:timers/promises";

export type Provider = "ollama" | "openai" | "openrouter" | "anthropic";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  provider: Provider;
  baseUrl?: string;
  model: string;
  apiKey?: string;
  siteUrl?: string;
  appName?: string;
  temperature?: number;
  timeout?: number;
  maxTokens?: number;
}

export interface ProviderModelsResult {
  models: string[];
  contextWindows: Record<string, number>;
}

interface RequestOptions {
  signal?: AbortSignal;
  requestTag?: string;
  onRetry?: (event: {
    url: string;
    attempt: number;
    maxAttempts: number;
    backoffSeconds: number;
    error: string;
  }) => void;
}

const RETRY_MARKERS = [
  "429",
  "500",
  "502",
  "503",
  "504",
  "too many requests",
  "rate limit",
  "overloaded",
  "temporarily unavailable",
  "service unavailable",
  "timeout",
  "timed out",
  "connection reset",
  "try again later",
];

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

export function defaultBaseUrl(provider: Provider, override = ""): string {
  if (override.trim()) {
    return trimBaseUrl(override);
  }

  if (provider === "ollama") {
    return "http://127.0.0.1:11434";
  }
  if (provider === "openai") {
    return "https://api.openai.com";
  }
  if (provider === "openrouter") {
    return "https://openrouter.ai/api/v1";
  }
  return "https://api.anthropic.com";
}

function openAiChatEndpoint(baseUrl: string): string {
  return /\/(v1|api\/v1)$/.test(baseUrl) ? "/chat/completions" : "/v1/chat/completions";
}

function modelsEndpoint(baseUrl: string): string {
  return /\/(v1|api\/v1)$/.test(baseUrl) ? "/models" : "/v1/models";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRetryableError(error: unknown): boolean {
  const text = toErrorMessage(error).toLowerCase();
  return RETRY_MARKERS.some((marker) => text.includes(marker));
}

function truncateBody(text: string, max = 800): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function requestBodyBytes(body: RequestInit["body"]): number {
  if (!body) {
    return 0;
  }
  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  return 0;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  options?: RequestOptions,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  let timeoutTriggered = false;
  let upstreamAbortTriggered = false;
  const timer = globalThis.setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);
  const upstreamSignal = options?.signal;
  const handleUpstreamAbort = (): void => {
    upstreamAbortTriggered = true;
    controller.abort();
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", handleUpstreamAbort, { once: true });
    }
  }

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (timeoutTriggered) {
        const timeoutError = new Error(
          `Request timed out after ${timeoutSeconds}s${options?.requestTag ? ` [${options.requestTag}]` : ""} | url=${url} | payload_bytes=${requestBodyBytes(init.body)}`,
        );
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      if (upstreamAbortTriggered || upstreamSignal?.aborted) {
        const abortError = new Error(
          `Request aborted by upstream signal${options?.requestTag ? ` [${options.requestTag}]` : ""} | url=${url}`,
        );
        abortError.name = "AbortError";
        throw abortError;
      }
      throw error;
    }

    if (!response.ok) {
      const body = truncateBody(await response.text());
      throw new Error(`HTTP ${response.status} ${response.statusText} | response=${body}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${url} | response=${truncateBody(text)}`);
    }
  } finally {
    globalThis.clearTimeout(timer);
    if (upstreamSignal) {
      upstreamSignal.removeEventListener("abort", handleUpstreamAbort);
    }
  }
}

async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  maxAttempts = 6,
  options?: RequestOptions,
): Promise<unknown> {
  let attempt = 1;

  while (true) {
    try {
      return await fetchJson(url, init, timeoutSeconds, options);
    } catch (error) {
      if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw error;
      }
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }
      const backoffSeconds = Math.min(45, (2 ** (attempt - 1)) + Math.random());
      options?.onRetry?.({
        url,
        attempt,
        maxAttempts,
        backoffSeconds,
        error: toErrorMessage(error),
      });
      await delay(backoffSeconds * 1000);
      attempt += 1;
    }
  }
}

function buildHeaders(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if ((config.provider === "openai" || config.provider === "openrouter") && config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (config.provider === "openrouter") {
    if (config.siteUrl) {
      headers["HTTP-Referer"] = config.siteUrl;
    }
    if (config.appName) {
      headers["X-Title"] = config.appName;
    }
  }
  if (config.provider === "anthropic") {
    headers["x-api-key"] = config.apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
  }

  return headers;
}

function normalizeMessagesForAnthropic(messages: ChatMessage[]): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }>;
} {
  const systemChunks = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .filter((chunk) => chunk.trim().length > 0);

  const mapped = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: (message.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: [{ type: "text" as const, text: message.content }],
    }));

  return {
    system: systemChunks.join("\n\n"),
    messages: mapped,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractOpenAiText(payload: unknown): string {
  const root = asRecord(payload);
  const choices = asArray(root?.choices);
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  return asString(message?.content).trim();
}

function extractAnthropicText(payload: unknown): string {
  const root = asRecord(payload);
  const blocks = asArray(root?.content);
  const parts: string[] = [];

  for (const block of blocks) {
    const row = asRecord(block);
    if (asString(row?.type) === "text") {
      const text = asString(row?.text);
      if (text.trim().length > 0) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n").trim();
}

export function extractJsonObject(rawText: string): Record<string, unknown> {
  const text = rawText.trim();
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue to fenced/raw extraction.
  }

  const fencedMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue.
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

export async function chatComplete(
  config: LlmConfig,
  messages: ChatMessage[],
  options?: RequestOptions,
): Promise<string> {
  const provider = config.provider;
  const baseUrl = defaultBaseUrl(provider, config.baseUrl ?? "");
  const timeout = config.timeout ?? 180;
  const headers = buildHeaders(config);

  if (provider === "ollama") {
    const payload = {
      model: config.model,
      messages,
      stream: false,
      options: {
        temperature: config.temperature ?? 0.2,
      },
    };
    const data = await fetchJsonWithRetry(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, timeout, 6, options);
    const root = asRecord(data);
    const message = asRecord(root?.message);
    return asString(message?.content).trim();
  }

  if (provider === "openai" || provider === "openrouter") {
    const payload = {
      model: config.model,
      temperature: config.temperature ?? 0.2,
      messages,
    };
    const endpoint = openAiChatEndpoint(baseUrl);
    const data = await fetchJsonWithRetry(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, timeout, 6, options);
    return extractOpenAiText(data);
  }

  const anthropicMessages = normalizeMessagesForAnthropic(messages);
  const payload = {
    model: config.model,
    max_tokens: config.maxTokens ?? 4000,
    temperature: config.temperature ?? 0.2,
    system: anthropicMessages.system,
    messages: anthropicMessages.messages,
  };

  const data = await fetchJsonWithRetry(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, timeout, 6, options);
  return extractAnthropicText(data);
}

export async function chatCompleteJson(
  config: LlmConfig,
  messages: ChatMessage[],
  options?: RequestOptions,
): Promise<{ parsed: Record<string, unknown>; raw: string }> {
  const provider = config.provider;
  const baseUrl = defaultBaseUrl(provider, config.baseUrl ?? "");
  const timeout = config.timeout ?? 180;
  const headers = buildHeaders(config);

  if (provider === "ollama") {
    const payload = {
      model: config.model,
      messages,
      stream: false,
      format: "json",
      options: {
        temperature: config.temperature ?? 0.2,
      },
    };
    const data = await fetchJsonWithRetry(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, timeout, 6, options);
    const root = asRecord(data);
    const message = asRecord(root?.message);
    const raw = asString(message?.content);
    return {
      parsed: extractJsonObject(raw),
      raw,
    };
  }

  if (provider === "openai" || provider === "openrouter") {
    const endpoint = openAiChatEndpoint(baseUrl);
    const url = `${baseUrl}${endpoint}`;

    const payload = {
      model: config.model,
      temperature: config.temperature ?? 0.2,
      response_format: { type: "json_object" },
      messages,
    };

    const data = await fetchJsonWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, timeout, 6, options);
    const raw = extractOpenAiText(data);
    return { parsed: extractJsonObject(raw), raw };
  }

  const anthropicMessages = normalizeMessagesForAnthropic(messages);
  const payload = {
    model: config.model,
    max_tokens: config.maxTokens ?? 4000,
    temperature: config.temperature ?? 0.2,
    system: anthropicMessages.system,
    messages: anthropicMessages.messages,
  };

  const data = await fetchJsonWithRetry(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, timeout, 6, options);
  const raw = extractAnthropicText(data);
  return { parsed: extractJsonObject(raw), raw };
}

function parseContextWindow(row: Record<string, unknown>): number {
  const candidates = [
    row.context_length,
    row.max_context_length,
    row.input_token_limit,
    row.context_window,
    row.num_ctx,
  ];
  for (const value of candidates) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

export async function fetchProviderModelsWithMetadata(
  provider: Provider,
  options: {
    baseUrl?: string;
    apiKey?: string;
    siteUrl?: string;
    appName?: string;
    timeout?: number;
  },
): Promise<ProviderModelsResult> {
  const baseUrl = defaultBaseUrl(provider, options.baseUrl ?? "");
  const timeout = options.timeout ?? 30;
  const config: LlmConfig = {
    provider,
    model: "unused",
    timeout,
  };
  if (baseUrl) {
    config.baseUrl = baseUrl;
  }
  if (options.apiKey) {
    config.apiKey = options.apiKey;
  }
  if (options.siteUrl) {
    config.siteUrl = options.siteUrl;
  }
  if (options.appName) {
    config.appName = options.appName;
  }
  const headers = buildHeaders(config);
  const models = new Set<string>();
  const contextWindows: Record<string, number> = {};

  if (provider === "ollama") {
    const data = await fetchJsonWithRetry(`${baseUrl}/api/tags`, {
      method: "GET",
      headers,
    }, timeout);
    const root = asRecord(data);
    const rows = asArray(root?.models);
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) {
        continue;
      }
      const name = asString(record.name).trim();
      if (!name) {
        continue;
      }
      models.add(name);
      const window = parseContextWindow(record);
      if (window > 0) {
        contextWindows[name] = window;
      }
    }
  } else if (provider === "openai" || provider === "openrouter") {
    const endpoint = modelsEndpoint(baseUrl);
    const data = await fetchJsonWithRetry(`${baseUrl}${endpoint}`, {
      method: "GET",
      headers,
    }, timeout);
    const root = asRecord(data);
    const rows = asArray(root?.data);
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) {
        continue;
      }
      const name = asString(record.id).trim();
      if (!name) {
        continue;
      }
      models.add(name);
      const window = parseContextWindow(record);
      if (window > 0) {
        contextWindows[name] = window;
      }
    }
  } else {
    const data = await fetchJsonWithRetry(`${baseUrl}/v1/models`, {
      method: "GET",
      headers,
    }, timeout);
    const root = asRecord(data);
    const rows = asArray(root?.data);
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) {
        continue;
      }
      const name = asString(record.id).trim();
      if (!name) {
        continue;
      }
      models.add(name);
      const window = parseContextWindow(record);
      if (window > 0) {
        contextWindows[name] = window;
      }
    }
  }

  return {
    models: [...models].sort((a, b) => a.localeCompare(b)),
    contextWindows,
  };
}
