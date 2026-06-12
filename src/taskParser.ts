import { App } from "obsidian";
import { TaskNote } from "./types";

export interface TaskSourceOptions {
  sourceFolder?: string;     // "" or undefined → whole vault
  requiredProperty?: string; // "" or undefined → no requirement
  startProperty?: string;    // "" or undefined → "startDate"
  endProperty?: string;      // "" or undefined → "endDate"
}

export async function loadTaskNotes(
  app: App,
  opts: TaskSourceOptions = {}
): Promise<TaskNote[]> {
  const tasks: TaskNote[] = [];
  const scope = parseScope(opts);

  const startProp = (opts.startProperty ?? "").trim() || "startDate";
  const endProp   = (opts.endProperty ?? "").trim() || "endDate";

  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    if (!inScope(file.path, fm, scope)) continue;

    const get = (key: string) => getCI(fm, key);

    const rawStart = get(startProp);
    const rawEnd   = get(endProp);

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
      status:   firstString(get("status")),
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

/**
 * All status values among notes in scope (same folder/required-property
 * gates as loadTaskNotes — only the date requirement is waived). Used by
 * the bar context menu so a status stays offered even when no charted
 * task currently has it.
 */
export function collectVaultStatuses(
  app: App,
  opts: TaskSourceOptions = {}
): string[] {
  const scope = parseScope(opts);
  const seen = new Map<string, string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    if (!inScope(file.path, fm, scope)) continue;
    const s = firstString(getCI(fm, "status"));
    if (!s) continue;
    const key = s.toLowerCase();
    if (!seen.has(key)) seen.set(key, s);
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

// ── Scope (folder + required property) ──────────────────────────────────────

interface Scope {
  folder: string;   // "" → whole vault
  reqName: string;  // "" → no property requirement
  reqValue: string; // "" → property only has to exist
}

// "name" → property must exist (any value, empty included)
// "name: value" → property must exist AND contain that value
function parseScope(opts: TaskSourceOptions): Scope {
  const folder   = (opts.sourceFolder ?? "").replace(/^\/+|\/+$/g, "");
  const reqRaw   = (opts.requiredProperty ?? "").trim();
  const colonIdx = reqRaw.indexOf(":");
  const reqName  = (colonIdx >= 0 ? reqRaw.slice(0, colonIdx) : reqRaw).trim();
  const reqValue =
    colonIdx >= 0 ? reqRaw.slice(colonIdx + 1).trim().toLowerCase() : "";
  return { folder, reqName, reqValue };
}

function inScope(
  path: string,
  fm: Record<string, unknown>,
  scope: Scope
): boolean {
  if (scope.folder && !path.startsWith(scope.folder + "/")) return false;
  if (scope.reqName) {
    const val = getCI(fm, scope.reqName);
    // Property must EXIST — empty values count (Obsidian stores empty
    // properties as null, so only undefined means "absent")
    if (val === undefined) return false;
    if (scope.reqValue) {
      // Value match, case-insensitive; list properties match any element
      const values = Array.isArray(val) ? val : [val];
      return values.some(
        (v) => String(v).trim().toLowerCase() === scope.reqValue
      );
    }
  }
  return true;
}

/**
 * String value of a frontmatter field that may be stored as a list
 * (Obsidian's "List" property type, TaskNotes): first element wins.
 */
function firstString(raw: unknown): string {
  const v: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (v == null) return "";
  return String(v).trim();
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
