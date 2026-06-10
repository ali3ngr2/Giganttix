import { App, TFile } from "obsidian";

/**
 * Writes new start/end dates to a note's frontmatter after a drag.
 *
 * Uses Obsidian's official fileManager.processFrontMatter (atomic,
 * YAML-aware) instead of hand-rolled regex. Also cleans up obsolete
 * alias keys (start/end, any casing) and non-canonical casings of
 * startDate/endDate, so a dragged note ends up with exactly one
 * canonical pair.
 */
export async function updateTaskDates(
  app: App,
  filePath: string,
  newStart: string,
  newEnd: string
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) {
    console.warn(`[TaskGantt] File not found: ${filePath}`);
    return;
  }

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    for (const key of Object.keys(fm)) {
      const lower = key.toLowerCase();
      const isObsoleteAlias = lower === "start" || lower === "end";
      const isWrongCasing =
        (lower === "startdate" && key !== "startDate") ||
        (lower === "enddate" && key !== "endDate");
      if (isObsoleteAlias || isWrongCasing) delete fm[key];
    }
    fm.startDate = newStart;
    fm.endDate = newEnd;
  });
}

/** Writes progress (0–100, rounded) after a progress-handle drag. */
export async function updateTaskProgress(
  app: App,
  filePath: string,
  progress: number
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) {
    console.warn(`[TaskGantt] File not found: ${filePath}`);
    return;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    // Remove non-canonical casings (Progress, PROGRESS, …) — same cleanup
    // as updateTaskDates, else a duplicate lowercase key gets added
    for (const key of Object.keys(fm)) {
      if (key.toLowerCase() === "progress" && key !== "progress") delete fm[key];
    }
    fm.progress = clamped;
  });
}
