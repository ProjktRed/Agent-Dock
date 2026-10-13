import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopApi } from "@shared/api";

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel: string) => (callback: (value: any) => void) => {
  const listener = (_event: IpcRendererEvent, value: unknown) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: DesktopApi = {
  snapshot: invoke("snapshot") as DesktopApi["snapshot"],
  saveSettings: invoke("settings:save") as DesktopApi["saveSettings"],
  saveAgent: invoke("agent:save") as DesktopApi["saveAgent"],
  deleteAgent: invoke("agent:delete") as DesktopApi["deleteAgent"],
  saveCli: invoke("cli:save") as DesktopApi["saveCli"],
  deleteCli: invoke("cli:delete") as DesktopApi["deleteCli"],
  checkCli: invoke("cli:check") as DesktopApi["checkCli"],
  healths: invoke("cli:healths") as DesktopApi["healths"],
  detectOnPath: invoke("cli:detect") as DesktopApi["detectOnPath"],
  testConnection: invoke("cli:test") as DesktopApi["testConnection"],
  collectModels: invoke("cli:collectModels") as DesktopApi["collectModels"],
  detectModelsDir: invoke("cli:detectModelsDir") as DesktopApi["detectModelsDir"],
  pickDirectory: invoke("dialog:directory") as DesktopApi["pickDirectory"],
  pickTaskFile: invoke("dialog:task") as DesktopApi["pickTaskFile"],
  inspectDirectory: invoke("project:inspect") as DesktopApi["inspectDirectory"],
  addProject: invoke("project:add") as DesktopApi["addProject"],
  updateProject: invoke("project:update") as DesktopApi["updateProject"],
  removeProject: invoke("project:remove") as DesktopApi["removeProject"],
  setActiveProject: invoke("project:activate") as DesktopApi["setActiveProject"],
  status: invoke("engine:status") as DesktopApi["status"],
  launchCheck: invoke("engine:check") as DesktopApi["launchCheck"],
  control: invoke("engine:control") as DesktopApi["control"],
  usage: invoke("usage") as DesktopApi["usage"],
  localContext: invoke("usage:localContext") as DesktopApi["localContext"],
  history: invoke("project:history") as DesktopApi["history"],
  gitOwner: invoke("project:gitOwner") as DesktopApi["gitOwner"],
  engineLog: invoke("engine:log") as DesktopApi["engineLog"],
  skills: invoke("skills:list") as DesktopApi["skills"],
  importSkillFolder: invoke("skills:import") as DesktopApi["importSkillFolder"],
  roles: invoke("roles:list") as DesktopApi["roles"],
  saveRole: invoke("roles:save") as DesktopApi["saveRole"],
  deleteRole: invoke("roles:delete") as DesktopApi["deleteRole"],
  importRoleFolder: invoke("roles:import") as DesktopApi["importRoleFolder"],
  openPath: invoke("shell:open") as DesktopApi["openPath"],
  limits: invoke("limits:get") as DesktopApi["limits"],
  refreshLimits: invoke("limits:refresh") as DesktopApi["refreshLimits"],
  onLimits: subscribe("limits") as DesktopApi["onLimits"],
  models: invoke("models:get") as DesktopApi["models"],
  refreshModels: invoke("models:refresh") as DesktopApi["refreshModels"],
  onModels: subscribe("models") as DesktopApi["onModels"],
  updateStatus: invoke("update:status") as DesktopApi["updateStatus"],
  checkForUpdates: invoke("update:check") as DesktopApi["checkForUpdates"],
  applyUpdate: invoke("update:apply") as DesktopApi["applyUpdate"],
  onUpdate: subscribe("update") as DesktopApi["onUpdate"],
  windowControl: invoke("window") as DesktopApi["windowControl"],
  onStatus: subscribe("status") as DesktopApi["onStatus"],
  onHealth: subscribe("health") as DesktopApi["onHealth"],
  onNotice: subscribe("notice") as DesktopApi["onNotice"],
};

contextBridge.exposeInMainWorld("api", api);
