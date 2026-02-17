import { useMemo, useState } from "react";
import type { PromptOverrides } from "@/store/runtimeDefaults";
import {
  allKnownModels,
  contextProfileChoices,
  extractionModelChoices,
  fidelityTierChoices,
  providerChoices,
} from "@/store/runtimeDefaults";
import { useRendererStore } from "@/store/useRendererStore";
import { InlineStatus } from "./InlineStatus";

const PROMPT_FIELDS: Array<{ key: keyof PromptOverrides; label: string; rows: number }> = [
  { key: "personaObservationSystem", label: "Persona Observation System", rows: 5 },
  { key: "personaObservationUser", label: "Persona Observation User", rows: 8 },
  { key: "personaSynthesisSystem", label: "Persona Synthesis System", rows: 5 },
  { key: "personaSynthesisUser", label: "Persona Synthesis User", rows: 8 },
  { key: "memorySystem", label: "Memory Extraction System", rows: 5 },
  { key: "memoryUser", label: "Memory Extraction User", rows: 8 },
  { key: "memorySynthesisSystem", label: "Memory Synthesis System", rows: 5 },
  { key: "memorySynthesisUser", label: "Memory Synthesis User", rows: 8 },
];

function readInt(value: string, defaultValue: number, min = 0): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(min, Math.floor(parsed));
}

function readFloat(value: string, defaultValue: number, min = 0, max = 2): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(min, Math.min(max, parsed));
}

export const SettingsTab = (): JSX.Element => {
  const settings = useRendererStore((state) => state.settings);
  const discoveredModels = useRendererStore((state) => state.models);
  const providerModels = useRendererStore((state) => state.providerModels);
  const providerModelWindows = useRendererStore((state) => state.providerModelWindows);
  const modelsStep = useRendererStore((state) => state.steps.models);
  const setSettingsField = useRendererStore((state) => state.setSettingsField);
  const setPromptOverrideField = useRendererStore((state) => state.setPromptOverrideField);
  const applyPreset = useRendererStore((state) => state.applyPreset);
  const saveCurrentPreset = useRendererStore((state) => state.saveCurrentPreset);
  const deletePreset = useRendererStore((state) => state.deletePreset);
  const fetchProviderModels = useRendererStore((state) => state.fetchProviderModels);
  const [presetName, setPresetName] = useState(settings.selectedPresetName);
  const tierChoices = fidelityTierChoices();
  const extractionLabelMap = new Map(
    extractionModelChoices.map((row) => [row.value, row.label] as const),
  );
  const extractionOptions = Array.from(
    new Set([
      ...extractionModelChoices.map((row) => row.value),
      ...providerModels,
      settings.llmModel.trim(),
    ]),
  ).filter((value) => value.trim().length > 0).map((value) => ({
    value,
    label: extractionLabelMap.get(value) ?? value,
  }));
  const judgeOptions = Array.from(new Set([...allKnownModels(), ...providerModels]));
  const defaultModelSlugOptions = useMemo(() => {
    const options = new Set<string>(["gpt-4o"]);
    const currentDefault = settings.defaultModelSlug.trim();
    if (currentDefault) {
      options.add(currentDefault);
    }
    for (const row of discoveredModels) {
      const value = row.model.trim();
      if (value) {
        options.add(value);
      }
    }
    const hasAnthropicLogs = [...options].some((value) => /claude|anthropic/i.test(value));
    if (hasAnthropicLogs) {
      options.add("claude");
    }
    const sorted = [...options].filter((value) => value !== "gpt-4o").sort((a, b) => a.localeCompare(b));
    return ["gpt-4o", ...sorted];
  }, [discoveredModels, settings.defaultModelSlug]);

  const modelWindowHint = settings.llmModel.trim()
    ? providerModelWindows[settings.llmModel.trim()]
    : undefined;
  return (
    <section className="panel panel--section">
      <header className="panel__header">
        <h2>Settings</h2>
      </header>

      <div className="settings-api-key">
        <label className="field-block">
          <span>API key</span>
          <input
            type="password"
            value={settings.llmApiKey}
            onChange={(event) => setSettingsField("llmApiKey", event.target.value)}
            placeholder="sk-..."
          />
        </label>
      </div>

      <div className="settings-grid">
        <article className="panel panel--embedded">
          <header className="panel__header">
            <h3>Import Data</h3>
          </header>
          <label className="field-block">
            <span>Default model slug</span>
            <select
              value={settings.defaultModelSlug}
              onChange={(event) => setSettingsField("defaultModelSlug", event.target.value)}
            >
              {defaultModelSlugOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </article>

        <article className="panel panel--embedded">
          <header className="panel__header">
            <h3>Recover Persona</h3>
          </header>
          <div className="editor-grid">
            <label className="field-block">
              <span>Conversations to process</span>
              <input
                type="number"
                min={1}
                step={1}
                value={settings.recoverMaxConversations}
                onChange={(event) =>
                  setSettingsField(
                    "recoverMaxConversations",
                    readInt(event.target.value, settings.recoverMaxConversations, 1),
                  )
                }
              />
            </label>
            <label className="field-block">
              <span>Max memories</span>
              <input
                type="number"
                min={1}
                step={1}
                value={settings.maxMemories}
                onChange={(event) =>
                  setSettingsField(
                    "maxMemories",
                    readInt(event.target.value, settings.maxMemories, 1),
                  )
                }
              />
            </label>
            <label className="field-block">
              <span>Memories per chat</span>
              <input
                type="number"
                min={1}
                step={1}
                value={settings.memoryPerChatMax}
                onChange={(event) =>
                  setSettingsField(
                    "memoryPerChatMax",
                    readInt(event.target.value, settings.memoryPerChatMax, 1),
                  )
                }
              />
            </label>
            <label className="field-block">
              <span>Parallel LLM calls</span>
              <input
                type="number"
                min={1}
                step={1}
                value={settings.maxParallelCalls}
                onChange={(event) =>
                  setSettingsField(
                    "maxParallelCalls",
                    readInt(event.target.value, settings.maxParallelCalls, 1),
                  )
                }
              />
            </label>
            <details className="settings-accordion">
              <summary>Advanced Recovery Settings</summary>
              <div className="editor-grid">
                <label className="toggle-field" htmlFor="forceRerun">
                  <input
                    id="forceRerun"
                    type="checkbox"
                    checked={settings.forceRerun}
                    onChange={(event) => setSettingsField("forceRerun", event.target.checked)}
                  />
                  <span>Force rerun (ignore checkpoint + scanned cache)</span>
                </label>
                <label className="field-block">
                  <span>Sampling mode</span>
                  <select
                    value={settings.conversationSampling}
                    onChange={(event) =>
                      setSettingsField(
                        "conversationSampling",
                        event.target.value as "weighted-random" | "random-uniform" | "top",
                      )
                    }
                  >
                    <option value="weighted-random">weighted-random</option>
                    <option value="random-uniform">random-uniform</option>
                    <option value="top">top</option>
                  </select>
                </label>
                <label className="field-block">
                  <span>Context profile</span>
                  <select
                    value={settings.contextProfile}
                    onChange={(event) =>
                      setSettingsField(
                        "contextProfile",
                        event.target.value as "auto" | "64k" | "128k" | "200k" | "256k" | "1m",
                      )
                    }
                  >
                    {contextProfileChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-block">
                  <span>Max messages per conversation</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={settings.maxMessagesPerConversation}
                    onChange={(event) =>
                      setSettingsField(
                        "maxMessagesPerConversation",
                        readInt(event.target.value, settings.maxMessagesPerConversation, 1),
                      )
                    }
                  />
                </label>
                <label className="field-block">
                  <span>Max chars per conversation</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={settings.maxCharsPerConversation}
                    onChange={(event) =>
                      setSettingsField(
                        "maxCharsPerConversation",
                        readInt(event.target.value, settings.maxCharsPerConversation, 1),
                      )
                    }
                  />
                </label>
                <label className="field-block">
                  <span>Max total chars</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={settings.maxTotalChars}
                    onChange={(event) =>
                      setSettingsField(
                        "maxTotalChars",
                        readInt(event.target.value, settings.maxTotalChars, 1),
                      )
                    }
                  />
                </label>
                <label className="field-block">
                  <span>Model context window</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={settings.modelContextWindow}
                    onChange={(event) =>
                      setSettingsField(
                        "modelContextWindow",
                        readInt(event.target.value, settings.modelContextWindow, 1),
                      )
                    }
                  />
                </label>
              </div>
            </details>
          </div>
        </article>

        <article className="panel panel--embedded">
          <header className="panel__header">
            <h3>Fidelity Test</h3>
          </header>
          <div className="editor-grid">
            <label className="field-block">
              <span>Candidate models (comma or newline separated)</span>
              <textarea
                rows={5}
                value={settings.fidelityModelsCsv}
                onChange={(event) => setSettingsField("fidelityModelsCsv", event.target.value)}
                placeholder="gpt-4o,gpt-4o-mini,gpt-4.1"
              />
            </label>
            <label className="field-block">
              <span>Test prompts (one per line)</span>
              <textarea
                rows={7}
                value={settings.fidelityPromptsText}
                onChange={(event) => setSettingsField("fidelityPromptsText", event.target.value)}
              />
            </label>
            <label className="field-block">
              <span>Model tier</span>
              <select
                value={settings.fidelityTier}
                onChange={(event) => setSettingsField("fidelityTier", event.target.value)}
              >
                {tierChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-block">
              <span>Judge model (optional)</span>
              <select
                value={settings.judgeModel}
                onChange={(event) => setSettingsField("judgeModel", event.target.value)}
              >
                <option value="">(none)</option>
                {judgeOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </article>

        <article className="panel panel--embedded">
          <header className="panel__header">
            <h3>Provider + API</h3>
          </header>
          <div className="editor-grid">
            <div className="row">
              <label className="field-block">
                <span>Preset</span>
                <select
                  value={settings.selectedPresetName}
                  onChange={(event) => {
                    setSettingsField("selectedPresetName", event.target.value);
                    applyPreset(event.target.value);
                  }}
                >
                  {settings.presets.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-block">
                <span>Preset name</span>
                <input
                  type="text"
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  placeholder="openrouter-work"
                />
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => saveCurrentPreset(presetName)}
              >
                Save Preset
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => deletePreset(settings.selectedPresetName)}
              >
                Delete Preset
              </button>
            </div>

            <label className="field-block">
              <span>Provider</span>
              <select
                value={settings.llmProvider}
                onChange={(event) =>
                  setSettingsField("llmProvider", event.target.value as (typeof providerChoices)[number])
                }
              >
                {providerChoices.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-block">
              <span>Base URL</span>
              <input
                type="text"
                value={settings.llmBaseUrl}
                onChange={(event) => setSettingsField("llmBaseUrl", event.target.value)}
              />
            </label>
            <label className="field-block">
              <span>Model</span>
              <select
                value={settings.llmModel}
                onChange={(event) => setSettingsField("llmModel", event.target.value)}
              >
                {extractionOptions.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await fetchProviderModels();
              }}
              disabled={modelsStep.phase === "loading"}
            >
              {modelsStep.phase === "loading" ? "Loading Models..." : "Refresh Provider Models"}
            </button>
            <InlineStatus label="Provider Models" step={modelsStep} />
            {modelWindowHint ? (
              <p className="report-line">
                Context window for <strong>{settings.llmModel}</strong>: {modelWindowHint.toLocaleString()}
              </p>
            ) : null}

            <details className="settings-accordion">
              <summary>Advanced LLM Settings</summary>
              <div className="editor-grid">
                <label className="field-block">
                  <span>Temperature</span>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    value={settings.temperature}
                    onChange={(event) =>
                      setSettingsField(
                        "temperature",
                        readFloat(event.target.value, settings.temperature, 0, 2),
                      )
                    }
                  />
                </label>
                <label className="field-block">
                  <span>Request timeout (seconds)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={settings.requestTimeout}
                    onChange={(event) =>
                      setSettingsField(
                        "requestTimeout",
                        readInt(event.target.value, settings.requestTimeout, 1),
                      )
                    }
                  />
                </label>
              </div>
            </details>
          </div>
        </article>

        <article className="panel panel--embedded settings-grid__full">
          <header className="panel__header">
            <h3>Prompt Overrides</h3>
          </header>
          <div className="editor-grid prompt-overrides-grid">
            {PROMPT_FIELDS.map((field) => (
              <label key={field.key} className="field-block">
                <span>{field.label}</span>
                <textarea
                  rows={field.rows}
                  value={settings.promptOverrides[field.key]}
                  onChange={(event) => setPromptOverrideField(field.key, event.target.value)}
                />
              </label>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
};
