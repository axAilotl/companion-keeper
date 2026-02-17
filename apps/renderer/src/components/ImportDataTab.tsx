import { useState } from "react";
import { useRendererStore } from "@/store/useRendererStore";
import { InlineStatus } from "./InlineStatus";

export const ImportDataTab = (): JSX.Element => {
  const pickImportFile = useRendererStore((state) => state.pickImportFile);
  const runImportStage = useRendererStore((state) => state.runImportStage);
  const settings = useRendererStore((state) => state.settings);
  const fileName = useRendererStore((state) => state.fileName);
  const conversationCount = useRendererStore((state) => state.conversationCount);
  const models = useRendererStore((state) => state.models);
  const selectedModel = useRendererStore((state) => state.selectedModel);
  const importStep = useRendererStore((state) => state.steps.importData);
  const [pickedPath, setPickedPath] = useState("");
  const [pickedName, setPickedName] = useState("");

  const openPicker = async (): Promise<void> => {
    const picked = await pickImportFile();
    if (!picked) {
      return;
    }

    setPickedPath(picked.filePath);
    setPickedName(picked.fileName);
    await runImportStage(picked.filePath);
  };

  return (
    <section className="panel panel--section">
      <header className="panel__header">
        <h2>Import Data</h2>
      </header>
      <p className="panel__hint">
        Select your export file and run import. The app will discover models, split to JSONL cache, and continue to the next tab.
      </p>

      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => void openPicker()}>
          Choose File
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await runImportStage(pickedPath);
          }}
          disabled={importStep.phase === "loading" || pickedPath.trim().length === 0}
        >
          {importStep.phase === "loading" ? "Importing..." : "Import"}
        </button>
      </div>

      <InlineStatus label="Import Stage" step={importStep} />

      <div className="metadata-grid">
        <div>
          <span className="meta-label">Selected file</span>
          <strong>{pickedName || fileName || "-"}</strong>
        </div>
        <div>
          <span className="meta-label">Default model</span>
          <strong>{settings.defaultModelSlug}</strong>
        </div>
        <div>
          <span className="meta-label">Active model</span>
          <strong>{selectedModel || "-"}</strong>
        </div>
        <div>
          <span className="meta-label">Discovered models</span>
          <strong>{models.length > 0 ? models.length.toLocaleString() : "-"}</strong>
        </div>
        <div>
          <span className="meta-label">Conversations</span>
          <strong>{conversationCount > 0 ? conversationCount.toLocaleString() : "-"}</strong>
        </div>
      </div>
    </section>
  );
};
