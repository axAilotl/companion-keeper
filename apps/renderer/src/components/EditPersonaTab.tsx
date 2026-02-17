import { useEffect, useMemo } from "react";
import { useRendererStore, type EditSubTab } from "@/store/useRendererStore";
import { InlineStatus } from "./InlineStatus";
import { LoreSplitView } from "./LoreSplitView";

const SUBTABS: Array<{ id: EditSubTab; label: string }> = [
  { id: "persona_edit", label: "Persona Edit" },
  { id: "lore_edit", label: "Lore Edit" },
];

const CARD_FIELDS: Array<{
  key: "name" | "description" | "personality" | "scenario" | "firstMessage";
  label: string;
  multiline?: boolean;
  rows?: number;
}> = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description", multiline: true, rows: 9 },
  { key: "personality", label: "Personality", multiline: true, rows: 6 },
  { key: "scenario", label: "Scenario", multiline: true, rows: 5 },
  { key: "firstMessage", label: "First Message", multiline: true, rows: 5 },
];

function formatImageSource(imagePath: string): string {
  const normalizedPath = imagePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    const rest = normalizedPath
      .slice(2)
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return rest.length > 0 ? `file:///${drive}/${rest}` : `file:///${drive}`;
  }
  if (normalizedPath.startsWith("/")) {
    const encoded = normalizedPath
      .split("/")
      .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
      .join("/");
    return `file://${encoded}`;
  }
  return `file://${encodeURIComponent(normalizedPath)}`;
}

function fileLabel(filePath: string): string {
  if (!filePath) {
    return "No image selected";
  }
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function outputDirLabel(outputDir: string): string {
  const cleaned = outputDir.trim();
  if (!cleaned) {
    return "";
  }
  const parts = cleaned.split(/[\\/]/).filter((part) => part.length > 0);
  const tail = parts[parts.length - 1] ?? cleaned;
  return `${tail} - ${cleaned}`;
}

export const EditPersonaTab = (): JSX.Element => {
  const editSubTab = useRendererStore((state) => state.editSubTab);
  const setEditSubTab = useRendererStore((state) => state.setEditSubTab);
  const card = useRendererStore((state) => state.card);
  const memories = useRendererStore((state) => state.memories);
  const activeMemoryId = useRendererStore((state) => state.activeMemoryId);
  const outputDir = useRendererStore((state) => state.outputDir);
  const recentOutputDirs = useRendererStore((state) => state.settings.recentOutputDirs);
  const setOutputDir = useRendererStore((state) => state.setOutputDir);
  const setCardField = useRendererStore((state) => state.setCardField);
  const setActiveMemory = useRendererStore((state) => state.setActiveMemory);
  const addMemory = useRendererStore((state) => state.addMemory);
  const removeMemory = useRendererStore((state) => state.removeMemory);
  const updateMemoryTitle = useRendererStore((state) => state.updateMemoryTitle);
  const updateMemoryKeys = useRendererStore((state) => state.updateMemoryKeys);
  const updateMemoryContent = useRendererStore((state) => state.updateMemoryContent);
  const loadReview = useRendererStore((state) => state.loadReview);
  const saveReview = useRendererStore((state) => state.saveReview);
  const runExportPersona = useRendererStore((state) => state.runExportPersona);
  const appendMemories = useRendererStore((state) => state.appendMemories);
  const pickPersonaImageFile = useRendererStore((state) => state.pickPersonaImageFile);
  const personaImagePath = useRendererStore((state) => state.personaImagePath);
  const personaImagePreviewDataUrl = useRendererStore((state) => state.personaImagePreviewDataUrl);
  const setPersonaImagePath = useRendererStore((state) => state.setPersonaImagePath);
  const loadStep = useRendererStore((state) => state.steps.load);
  const saveStep = useRendererStore((state) => state.steps.save);
  const exportStep = useRendererStore((state) => state.steps.export);
  const appendStep = useRendererStore((state) => state.steps.append);
  const imageSrc = useMemo(() => {
    if (personaImagePreviewDataUrl.trim().length > 0) {
      return personaImagePreviewDataUrl;
    }
    if (personaImagePath.trim().length > 0) {
      return formatImageSource(personaImagePath);
    }
    return "";
  }, [personaImagePath, personaImagePreviewDataUrl]);

  const outputDirOptions = useMemo(() => {
    const cleanedCurrent = outputDir.trim();
    if (!cleanedCurrent) {
      return recentOutputDirs;
    }
    if (recentOutputDirs.includes(cleanedCurrent)) {
      return recentOutputDirs;
    }
    return [cleanedCurrent, ...recentOutputDirs];
  }, [outputDir, recentOutputDirs]);
  const selectedOutputDir = outputDir.trim() || outputDirOptions[0] || "";

  useEffect(() => {
    if (!outputDir.trim() && outputDirOptions.length > 0) {
      setOutputDir(outputDirOptions[0] ?? "");
    }
  }, [outputDir, outputDirOptions, setOutputDir]);

  return (
    <section className="panel panel--section">
      <header className="panel__header">
        <h2>Edit Persona</h2>
      </header>
      <p className="panel__hint">
        Edit card and lorebook content, upload persona image, and export a clean persona package.
      </p>

      <div className="sub-tabs" role="tablist" aria-label="Persona editor tabs">
        {SUBTABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={editSubTab === tab.id}
            className={editSubTab === tab.id ? "sub-tabs__item sub-tabs__item--active" : "sub-tabs__item"}
            onClick={() => setEditSubTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="row">
        <label className="field-inline" htmlFor="outputDir">
          Output directory
          <select
            id="outputDir"
            value={selectedOutputDir}
            onChange={(event) => setOutputDir(event.target.value)}
            disabled={outputDirOptions.length === 0}
          >
            {outputDirOptions.length === 0 ? (
              <option value="">No completed runs found yet</option>
            ) : (
              outputDirOptions.map((dir) => (
                <option key={dir} value={dir}>
                  {outputDirLabel(dir)}
                </option>
              ))
            )}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            if (outputDir !== selectedOutputDir) {
              setOutputDir(selectedOutputDir);
            }
            await loadReview();
          }}
          disabled={loadStep.phase === "loading" || selectedOutputDir.trim().length === 0}
        >
          {loadStep.phase === "loading" ? "Loading..." : "Load Existing"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await saveReview();
          }}
          disabled={saveStep.phase === "loading"}
        >
          {saveStep.phase === "loading" ? "Saving..." : "Save Edits"}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={async () => {
            await runExportPersona();
          }}
          disabled={exportStep.phase === "loading"}
        >
          {exportStep.phase === "loading" ? "Exporting..." : "Export Persona"}
        </button>
      </div>

      <InlineStatus label="Load Existing" step={loadStep} />
      <InlineStatus label="Save Edits" step={saveStep} />
      <InlineStatus label="Export Persona" step={exportStep} />

      {editSubTab === "persona_edit" ? (
        <>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await pickPersonaImageFile();
              }}
            >
              Upload Persona Image
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPersonaImagePath("");
              }}
            >
              Clear Image
            </button>
            <p className="report-line">Image: {fileLabel(personaImagePath)}</p>
          </div>

          {imageSrc ? (
            <div className="persona-image-preview">
              <img src={imageSrc} alt="Persona preview" />
            </div>
          ) : (
            <div className="empty-box">
              <p>No persona image loaded.</p>
            </div>
          )}

          <div className="editor-grid">
            {CARD_FIELDS.map((field) => (
              <label key={field.key} className="field-block">
                <span>{field.label}</span>
                {field.multiline ? (
                  <textarea
                    rows={field.rows ?? 5}
                    value={card[field.key]}
                    onChange={(event) => setCardField(field.key, event.target.value)}
                  />
                ) : (
                  <input
                    type="text"
                    value={card[field.key]}
                    onChange={(event) => setCardField(field.key, event.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
        </>
      ) : null}

      {editSubTab === "lore_edit" ? (
        <>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => addMemory()}
            >
              Add Lore Entry
            </button>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await appendMemories();
              }}
              disabled={appendStep.phase === "loading" || selectedOutputDir.trim().length === 0}
            >
              {appendStep.phase === "loading" ? "Appending..." : "Append Memories"}
            </button>
          </div>
          <InlineStatus label="Append Memories" step={appendStep} />
          <LoreSplitView
            editable
            memories={memories}
            activeMemoryId={activeMemoryId}
            onSelectMemory={(id) => setActiveMemory(id)}
            onTitleChange={(id, value) => updateMemoryTitle(id, value)}
            onKeysChange={(id, value) => updateMemoryKeys(id, value)}
            onContentChange={(id, value) => updateMemoryContent(id, value)}
            onRemoveMemory={(id) => removeMemory(id)}
          />
        </>
      ) : null}
    </section>
  );
};
