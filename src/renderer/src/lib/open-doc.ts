/**
 * Opens a bundled guide with the default app, or the online copy when that fails: the path is refused,
 * missing, or Windows has no app for the file type (shell:open then returns the reason instead of "").
 */
export async function openDoc(openPath: (target: string) => Promise<string>, local: string, online: string, openUrl: (url: string) => void): Promise<void> {
  try {
    if (!(await openPath(local))) return;
  } catch {
    // refused or failed: use the online copy
  }
  openUrl(online);
}
