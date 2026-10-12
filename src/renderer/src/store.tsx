import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ControlAction, Notice } from "@shared/api";
import type { Agent, AppSnapshot, CliConnection, CliHealth, Project, ProjectStatus, Settings } from "@shared/types";

export type Route = "overview" | "projects" | "agents" | "clis" | "settings";
interface Toast extends Notice {
  id: number;
}

interface AppContextValue {
  snap: AppSnapshot;
  statuses: Record<string, ProjectStatus>;
  healths: Record<string, CliHealth>;
  route: Route;
  go: (route: Route) => void;
  activeProject: Project | null;
  activeStatus: ProjectStatus | null;
  setActive: (id: string | null) => Promise<void>;
  toast: (kind: Notice["kind"], message: string) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  saveSettings: (next: Settings) => Promise<void>;
  updateSettings: (fn: (s: Settings) => Settings) => Promise<void>;
  saveProject: (p: Project) => Promise<void>;
  setProjects: (projects: Project[]) => void;
  setAgents: (agents: Agent[]) => void;
  setClis: (clis: CliConnection[]) => void;
  control: (projectId: string, action: ControlAction, successMessage?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  promptOpen: boolean;
  setPromptOpen: (v: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
let toastId = 0;

export function AppProvider({ initial, children }: { initial: AppSnapshot; children: ReactNode }) {
  const [snap, setSnap] = useState(initial);
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [healths, setHealths] = useState<Record<string, CliHealth>>({});
  const [route, setRoute] = useState<Route>("overview");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);

  const toast = useCallback((kind: Notice["kind"], message: string) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4500);
  }, []);

  useEffect(() => {
    const offStatus = window.api.onStatus((s) => setStatuses((prev) => ({ ...prev, [s.projectId]: s })));
    const offHealth = window.api.onHealth((h) => setHealths((prev) => ({ ...prev, [h.id]: h })));
    const offNotice = window.api.onNotice((n) => toast(n.kind, n.message));
    void window.api.healths().then((list) => setHealths(Object.fromEntries(list.map((h) => [h.id, h]))));
    // The poller only pushes active/running projects; load every project's status once so lists are complete.
    for (const p of initial.projects.filter((x) => !x.archived)) {
      void window.api.status(p.id).then((s) => setStatuses((prev) => ({ [s.projectId]: s, ...prev }))).catch(() => {});
    }
    return () => {
      offStatus();
      offHealth();
      offNotice();
    };
  }, [toast]);

  useEffect(() => {
    document.documentElement.dataset.theme = snap.settings.general.theme;
    document.documentElement.style.setProperty("--a", snap.settings.general.accent);
  }, [snap.settings.general.theme, snap.settings.general.accent]);

  const refresh = useCallback(async () => setSnap(await window.api.snapshot()), []);
  const saveSettings = useCallback(async (next: Settings) => {
    const saved = await window.api.saveSettings(next);
    setSnap((s) => ({ ...s, settings: saved }));
  }, []);
  const updateSettings = useCallback(async (fn: (s: Settings) => Settings) => saveSettings(fn(snap.settings)), [saveSettings, snap.settings]);

  const activeProject = snap.projects.find((p) => p.id === snap.settings.activeProjectId && !p.archived) ?? null;

  const value = useMemo<AppContextValue>(
    () => ({
      snap,
      statuses,
      healths,
      route,
      go: setRoute,
      activeProject,
      activeStatus: activeProject ? statuses[activeProject.id] ?? null : null,
      setActive: async (id) => {
        await window.api.setActiveProject(id);
        setSnap((s) => ({ ...s, settings: { ...s.settings, activeProjectId: id } }));
        if (id) setStatuses((prev) => prev);
      },
      toast,
      toasts,
      dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
      saveSettings,
      updateSettings,
      saveProject: async (p) => {
        const projects = await window.api.updateProject(p);
        setSnap((s) => ({ ...s, projects }));
      },
      setProjects: (projects) => setSnap((s) => ({ ...s, projects })),
      setAgents: (agents) => setSnap((s) => ({ ...s, agents })),
      setClis: (clis) => setSnap((s) => ({ ...s, clis })),
      control: async (projectId, action, successMessage) => {
        try {
          await window.api.control(projectId, action);
          if (successMessage) toast("success", successMessage);
          setStatuses({ ...statuses, [projectId]: await window.api.status(projectId) });
          return true;
        } catch (error) {
          toast("error", (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
          return false;
        }
      },
      refresh,
      collapsed,
      setCollapsed,
      promptOpen,
      setPromptOpen,
    }),
    [snap, statuses, healths, route, activeProject, toast, toasts, saveSettings, updateSettings, refresh, collapsed, promptOpen],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

/** Strip Electron's IPC wrapper from error messages shown to the user. */
export function cleanError(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
