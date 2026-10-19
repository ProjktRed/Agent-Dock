import { rename, rm } from "node:fs/promises";

// Antivirus and search indexing briefly hold files open on Windows, so a rename that replaces a file can
// fail with EPERM/EACCES/EBUSY for a moment. Retry for up to about five seconds before giving up.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const DEFAULT_BUDGET_MS = 5_000;

export async function renameWithRetry(from, to, { budgetMs = DEFAULT_BUDGET_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), renameImpl = rename } = {}) {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await renameImpl(from, to);
    } catch (error) {
      if (!TRANSIENT.has(error.code) || waited >= budgetMs) throw error;
      const delay = Math.min(250, 10 * 2 ** Math.min(attempt, 5));
      await sleep(delay);
      waited += delay;
    }
  }
}

/** Replaces `file` with an already written `temporary`; the temporary file is removed if that fails. */
export async function replaceWithRetry(temporary, file, options) {
  try {
    await renameWithRetry(temporary, file, options);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
