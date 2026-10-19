export type SettingsSection = "general" | "skills" | "workflow" | "context" | "safety" | "updates" | "advanced";

let pendingSection: SettingsSection | null = null;
/** Open a specific section the next time the Settings page mounts (call before go("settings")). */
export const openSettingsSection = (section: SettingsSection) => {
  pendingSection = section;
};
/** The section requested with openSettingsSection, once. */
export const takeSettingsSection = (): SettingsSection | null => {
  const section = pendingSection;
  pendingSection = null;
  return section;
};
