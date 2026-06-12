import { App, TFile } from "obsidian";

/**
 * Looks up the note and runs an atomic frontmatter mutation on it via
 * Obsidian's official fileManager.processFrontMatter (YAML-aware) —
 * shared plumbing for all writers below.
 */
async function processTaskFrontmatter(
  app: App,
  filePath: string,
  fn: (fm: Record<string, unknown>) => void
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) {
    console.warn(`[TaskGantt] File not found: ${filePath}`);
    return;
  }
  await app.fileManager.processFrontMatter(file, fn);
}

/**
 * Writes new start/end dates to a note's frontmatter after a drag.
 * Casing-preserving: writes to the existing keys whatever their casing
 * (other plugins may own them); the configured names are only used when
 * the property doesn't exist yet. Never deletes or renames anything.
 */
export async function updateTaskDates(
  app: App,
  filePath: string,
  newStart: string,
  newEnd: string,
  startProp = "startDate",
  endProp = "endDate"
): Promise<void> {
  const startLower = startProp.toLowerCase();
  const endLower   = endProp.toLowerCase();

  await processTaskFrontmatter(app, filePath, (fm) => {
    const keys = Object.keys(fm);
    const startKey = keys.find((k) => k.toLowerCase() === startLower) ?? startProp;
    const endKey   = keys.find((k) => k.toLowerCase() === endLower)   ?? endProp;
    fm[startKey] = newStart;
    fm[endKey] = newEnd;
  });
}

/**
 * Writes a new status value (from the bar context menu).
 *
 * Deliberately shape- and casing-preserving: other plugins (e.g. TaskNotes)
 * and the Obsidian property editor may own this property. Writes to the
 * existing key whatever its casing, keeps list values as lists, and never
 * deletes or renames anything.
 */
export async function updateTaskStatus(
  app: App,
  filePath: string,
  status: string
): Promise<void> {
  await processTaskFrontmatter(app, filePath, (fm) => {
    const key =
      Object.keys(fm).find((k) => k.toLowerCase() === "status") ?? "status";
    fm[key] = Array.isArray(fm[key]) ? [status] : status;
  });
}

/** Writes progress (0–100, rounded) after a progress-handle drag. */
export async function updateTaskProgress(
  app: App,
  filePath: string,
  progress: number
): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  await processTaskFrontmatter(app, filePath, (fm) => {
    // Casing-preserving, same policy as updateTaskDates/updateTaskStatus
    const key =
      Object.keys(fm).find((k) => k.toLowerCase() === "progress") ?? "progress";
    fm[key] = clamped;
  });
}
