import { useEffect } from "react";
import { useApp } from "./store";
import { Sidebar, StatusBar, TitleBar, Toasts } from "./components/Shell";
import { OverviewPage } from "./pages/overview/Overview";
import { ProjectsPage } from "./pages/projects/Projects";
import { AgentsPage } from "./pages/Agents";
import { WorkflowPage } from "./pages/Workflow";
import { ClisPage } from "./pages/clis/Clis";
import { SettingsPage } from "./pages/Settings";
import { FirstLaunch } from "./pages/FirstLaunch";

export function App() {
  const app = useApp();
  const { route, snap, go, collapsed, setCollapsed, setPromptOpen, promptOpen, activeProject, activeStatus, control } = app;
  const firstLaunch = !snap.settings.onboardingComplete && snap.projects.length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select");
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPromptOpen(!promptOpen);
      } else if (e.ctrlKey && e.key.toLowerCase() === "b" && !typing) {
        e.preventDefault();
        setCollapsed(!collapsed);
      } else if (e.ctrlKey && e.key.toLowerCase() === "n" && !typing) {
        e.preventDefault();
        go("projects");
        setTimeout(() => window.dispatchEvent(new Event("app:add-project")), 0);
      } else if (activeProject && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (activeStatus?.runState === "running") void control(activeProject.id, "pause", "Will pause after the current task");
        else if (activeStatus?.runState === "paused" || activeStatus?.runState === "pausing") void control(activeProject.id, "resume", "Resumed");
      } else if (activeProject && e.key === "F5" && !e.shiftKey) {
        e.preventDefault();
        if (!activeStatus?.processAlive && ["idle", "complete"].includes(activeStatus?.runState ?? "idle")) void control(activeProject.id, "start", "Automation started");
      } else if (activeProject && e.key === "F5" && e.shiftKey && activeStatus?.processAlive) {
        e.preventDefault();
        void control(activeProject.id, "stop", "Will stop at the next safe point");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promptOpen, collapsed, activeProject, activeStatus, control, go, setCollapsed, setPromptOpen]);

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <Sidebar />
        <main className="main" id="main">
          {firstLaunch && route === "overview" ? (
            <FirstLaunch />
          ) : (
            <>
              {route === "overview" && <OverviewPage />}
              {route === "projects" && <ProjectsPage />}
              {route === "workflow" && <WorkflowPage />}
              {route === "agents" && <AgentsPage />}
              {route === "clis" && <ClisPage />}
              {route === "settings" && <SettingsPage />}
            </>
          )}
        </main>
      </div>
      <StatusBar />
      <Toasts />
    </div>
  );
}
