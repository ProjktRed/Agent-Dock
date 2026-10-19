import { lazy, Suspense, useEffect } from "react";
import { useApp } from "./store";
import { Sidebar, StatusBar, TitleBar, Toasts } from "./components/Shell";
import { OverviewPage } from "./pages/overview/Overview";

// Overview opens first; the other pages load when first visited.
const ProjectsPage = lazy(() => import("./pages/projects/Projects").then((m) => ({ default: m.ProjectsPage })));
const AgentsPage = lazy(() => import("./pages/Agents").then((m) => ({ default: m.AgentsPage })));
const WorkflowPage = lazy(() => import("./pages/Workflow").then((m) => ({ default: m.WorkflowPage })));
const ClisPage = lazy(() => import("./pages/clis/Clis").then((m) => ({ default: m.ClisPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const FirstLaunch = lazy(() => import("./pages/FirstLaunch").then((m) => ({ default: m.FirstLaunch })));
const PageLoading = () => <div className="stack" style={{ gap: 12 }}><div className="skel" style={{ width: "40%" }} /><div className="skel" style={{ width: "70%" }} /></div>;

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
          <Suspense fallback={<PageLoading />}>
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
          </Suspense>
        </main>
      </div>
      <StatusBar />
      <Toasts />
    </div>
  );
}
