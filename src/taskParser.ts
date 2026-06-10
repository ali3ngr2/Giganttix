import { App } from "obsidian";
import { TaskNote } from "./types";

export interface TaskSourceOptions {
  sourceFolder?: string;     // "" or undefined → whole vault
  requiredProperty?: string; // "" or undefined → no requirement
}

export async function loadTaskNotes(
  app: App,
  opts: TaskSourceOptions = {}
): Promise<TaskNote[]> {
  const tasks: TaskNote[] = [];
  const folder = (opts.sourceFolder ?? "").replace(/^\/+|\/+$/g, "");

  // "name" → property must exist (any value, empty included)
  // "name: value" → property must exist AND contain that value
  const reqRaw   = (opts.requiredProperty ?? "").trim();
  const colonIdx = reqRaw.indexOf(":");
  const reqName  = (colonIdx >= 0 ? reqRaw.slice(0, colonIdx) : reqRaw).trim();
  const reqValue = colonIdx >= 0 ? reqRaw.slice(colonIdx + 1).trim().toLowerCase() : "";

  for (const file of app.vault.getMarkdownFiles()) {
    if (folder && !file.path.startsWith(folder + "/")) continue;

    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) continue;

    const get = (key: string) => getCI(fm, key);

    if (reqName) {
      const val = get(reqName);
      // Property must EXIST — empty values count (Obsidian stores empty
      // properties as null, so only undefined means "absent")
      if (val === undefined) continue;
      if (reqValue) {
        // Value match, case-insensitive; list properties match any element
        const values = Array.isArray(val) ? val : [val];
        const hit = values.some(
          (v) => String(v).trim().toLowerCase() === reqValue
        );
        if (!hit) continue;
      }
    }

    const rawStart = get("startDate") ?? get("start");
    const rawEnd   = get("endDate")   ?? get("end");

    if (!rawStart && !rawEnd) continue;

    const start = normalizeDate(rawStart);
    const end   = normalizeDate(rawEnd);

    const fallback = start || end;
    if (!fallback) continue;

    const safeStart = start ?? fallback;
    const safeEnd   = end   ?? fallback;

    // Swap if end before start — prevents Frappe negative-width crash
    const [s, e] = safeStart <= safeEnd ? [safeStart, safeEnd] : [safeEnd, safeStart];

    // Clamp progress: non-numeric values would feed NaN into SVG widths
    const rawProgress = Number(get("progress") ?? 0);
    const progress = Number.isFinite(rawProgress)
      ? Math.max(0, Math.min(100, rawProgress))
      : 0;

    tasks.push({
      id:       file.path,
      name:     file.basename,
      start:    s,
      end:      e,
      status:   String(get("status") ?? ""),
      progress,
      client:   parseClient(get("client")),
    });
  }

  tasks.sort((a, b) => a.end.localeCompare(b.end));
  return tasks;
}

export function collectStatuses(tasks: TaskNote[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tasks) {
    if (!t.status) continue;
    const key = t.status.toLowerCase();
    if (!seen.has(key)) seen.set(key, t.status);
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

function getCI(obj: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

function normalizeDate(raw: unknown): string | null {
  if (!raw) return null;
  if (raw instanceof Date) return formatDate(raw);
  const s = String(raw).trim();

  // YYYY-MM-DD (with optional time suffix) — use the date part verbatim.
  // Never via new Date(string): JS parses date-only ISO as UTC midnight,
  // which shifts back one day when formatted locally west of UTC.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // Slash formats — build from components (timezone-safe).
  // Tries M/D/YYYY first, then D/M/YYYY (same preference as before).
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const a = Number(slash[1]), b = Number(slash[2]), y = Number(slash[3]);
    return ymdFromParts(y, a, b) ?? ymdFromParts(y, b, a);
  }

  // Fallback for verbose formats ("June 5, 2026") — these parse as local
  // time. Bare YYYY-MM-DD never reaches here (handled above).
  const parsed = new Date(s);
  if (ok(parsed)) return formatDate(parsed);
  return null;
}

function ymdFromParts(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12) return null;
  const dim = new Date(y, m, 0).getDate(); // days in month m
  if (d < 1 || d > dim) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseClient(raw: unknown): string {
  if (!raw) return "";
  // Display-time cleanup only: strip wikilink brackets from the serialized
  // string ([[Name]] → Name, [[path|Display]] → Display). Deliberately does
  // NOT touch the raw value's structure — extracting .path/.display from
  // Obsidian's link objects broke clients entirely in past attempts.
  return String(raw)
    .trim()
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
    .trim();
}

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}
function ok(d: Date): boolean {
  return d instanceof Date && !isNaN(d.getTime());
}
