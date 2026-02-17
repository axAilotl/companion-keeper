import type { MemoryEntry } from "@gptdataexport/shared";

interface LoreSplitViewProps {
  memories: MemoryEntry[];
  activeMemoryId: string | null;
  onSelectMemory: (id: string) => void;
  editable?: boolean;
  onTitleChange?: (id: string, value: string) => void;
  onKeysChange?: (id: string, value: string) => void;
  onContentChange?: (id: string, value: string) => void;
  onRemoveMemory?: (id: string) => void;
}

function memoryTitle(memory: MemoryEntry): string {
  return memory.name || memory.keys[0] || memory.id;
}

export const LoreSplitView = ({
  memories,
  activeMemoryId,
  onSelectMemory,
  editable = false,
  onTitleChange,
  onKeysChange,
  onContentChange,
  onRemoveMemory,
}: LoreSplitViewProps): JSX.Element => {
  if (memories.length === 0) {
    return (
      <div className="empty-box">
        <p>No lore entries yet.</p>
      </div>
    );
  }

  const active = memories.find((memory) => memory.id === activeMemoryId) ?? memories[0];
  const activeKeys = active.keys.join(", ");

  return (
    <div className="lore-split">
      <aside className="lore-split__list" aria-label="Lore entries">
        {memories.map((memory) => {
          const selected = memory.id === active.id;
          return (
            <button
              type="button"
              key={memory.id}
              className={selected ? "lore-item lore-item--active" : "lore-item"}
              onClick={() => onSelectMemory(memory.id)}
            >
              <strong>{memoryTitle(memory)}</strong>
              <span>{memory.keys.join(", ") || "untagged"}</span>
            </button>
          );
        })}
      </aside>

      <section className="lore-split__content">
        {editable ? (
          <div className="editor-grid">
            <label className="field-block">
              <span>Lore Name</span>
              <input
                type="text"
                value={active.name || active.id}
                onChange={(event) => onTitleChange?.(active.id, event.target.value)}
              />
            </label>
            <label className="field-block">
              <span>Keys (comma-separated)</span>
              <input
                type="text"
                value={activeKeys}
                onChange={(event) => onKeysChange?.(active.id, event.target.value)}
              />
            </label>
            <label className="field-block">
              <span>Content</span>
              <textarea
                rows={12}
                value={active.content}
                onChange={(event) => onContentChange?.(active.id, event.target.value)}
              />
            </label>
            <div className="row row--tight">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => onRemoveMemory?.(active.id)}
              >
                Remove Entry
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="lore-split__content-header">
              <h3>{memoryTitle(active)}</h3>
              <p>{activeKeys || "No keys"}</p>
            </header>
            <article className="lore-preview-block">
              <pre>{active.content}</pre>
            </article>
          </>
        )}
      </section>
    </div>
  );
};
