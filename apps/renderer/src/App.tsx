import { useEffect } from "react";
import { EditPersonaTab } from "@/components/EditPersonaTab";
import { FidelityTestTab } from "@/components/FidelityTestTab";
import { ImportDataTab } from "@/components/ImportDataTab";
import { RecoverPersonaTab } from "@/components/RecoverPersonaTab";
import { SettingsTab } from "@/components/SettingsTab";
import { useRendererStore, type AppTab } from "@/store/useRendererStore";

export const App = (): JSX.Element => {
  const appTab = useRendererStore((state) => state.appTab);
  const setAppTab = useRendererStore((state) => state.setAppTab);
  const applyJobEvent = useRendererStore((state) => state.applyJobEvent);
  const hydrateSettings = useRendererStore((state) => state.hydrateSettings);

  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    const unsubscribe = window.desktopApi?.onJobEvent?.((event) => {
      applyJobEvent(event);
    });
    return () => {
      unsubscribe?.();
    };
  }, [applyJobEvent]);

  const tabs: Array<{ id: AppTab; label: string }> = [
    { id: "import_data", label: "Import Data" },
    { id: "recover_persona", label: "Recover Persona" },
    { id: "edit_persona", label: "Edit Persona" },
    { id: "fidelity_test", label: "Fidelity Test" },
    { id: "settings", label: "Settings" },
  ];

  const renderActiveTab = (): JSX.Element => {
    if (appTab === "import_data") {
      return <ImportDataTab />;
    }
    if (appTab === "recover_persona") {
      return <RecoverPersonaTab />;
    }
    if (appTab === "edit_persona") {
      return <EditPersonaTab />;
    }
    if (appTab === "fidelity_test") {
      return <FidelityTestTab />;
    }
    return <SettingsTab />;
  };

  return (
    <main className="desktop-shell">
      <header className="desktop-shell__header">
        <div>
          <p className="eyebrow">Companion Preservation Desktop</p>
          <h1>Persona Recovery Workbench</h1>
        </div>
      </header>

      <nav className="top-tabs" aria-label="Main workflow tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === appTab ? "top-tabs__item top-tabs__item--active" : "top-tabs__item"}
            onClick={() => setAppTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <section className="desktop-shell__content">
        {renderActiveTab()}
      </section>
    </main>
  );
};
