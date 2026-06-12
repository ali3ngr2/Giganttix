import { ItemView, WorkspaceLeaf, TFile, Menu } from "obsidian";
import Gantt from "frappe-gantt";
import { loadTaskNotes, collectStatuses, collectVaultStatuses, formatDate } from "./taskParser";
import { updateTaskDates, updateTaskProgress, updateTaskStatus } from "./frontmatterWriter";
import { TaskNote, FrappeTask } from "./types";
import type TaskGanttPlugin from "./main";
import { datePropertyNames, taskSourceOptions } from "./main";

export const GANTT_VIEW_TYPE = "task-gantt-view";
type ViewMode = "Day" | "Week" | "Month";

export class GanttView extends ItemView {
  private tasks: TaskNote[] = [];
  private gantt: Gantt | null = null;
  private statusFilter = "";
  private viewMode: ViewMode = "Week";
  private pendingWrites: Set<string> = new Set();
  private lastDragEnd = 0;

  private container!: HTMLElement;
  private filterSelect!: HTMLSelectElement;
  private modeButtons: Map<ViewMode, HTMLButtonElement> = new Map();

  constructor(leaf: WorkspaceLeaf, private plugin: TaskGanttPlugin) {
    super(leaf);
    const s = plugin.settings;
    // rememberLast on: restore last-used view/filter; off: open with defaults
    this.viewMode = s.rememberLast ? s.viewMode : s.defaultViewMode;
    this.statusFilter = s.rememberLast ? s.statusFilter : "";
  }

  getViewType()    { return GANTT_VIEW_TYPE; }
  getDisplayText() { return "Giganttix"; }
  getIcon()        { return "gantt-chart"; }

  async onOpen(): Promise<void> {
    this.buildShell();
    // Right-click on a bar: status menu (delegated — bars are recreated
    // on every redraw, the container is not)
    this.registerDomEvent(this.container, "contextmenu", (evt) => {
      const target = evt.target instanceof Element ? evt.target : null;
      const wrapper = target?.closest(".bar-wrapper");
      const task = this.tasks.find(
        (t) => t.id === wrapper?.getAttribute("data-id")
      );
      if (!task) return;
      evt.preventDefault();
      this.showBarMenu(evt, task);
    });
    // Left-click on a bar: open the note. Frappe 0.6.x only fires its
    // on_click on double-click and suppresses it for 1s after any drag,
    // so we handle clicks ourselves (delegated, like contextmenu above).
    this.registerDomEvent(this.container, "click", (evt) => {
      const target = evt.target instanceof Element ? evt.target : null;
      if (!target || target.closest(".handle")) return; // resize/progress handles
      const id = target.closest(".bar-wrapper")?.getAttribute("data-id");
      if (!id) return;
      // Ignore the click that ends a drag (frappe fires the date/progress
      // callback on mouseup, just before this click event)
      if (Date.now() - this.lastDragEnd < 400) return;
      this.openTaskNote(id);
    });
    await this.reload();
    this.registerEvent(
      this.app.metadataCache.on("changed", async (file) => {
        // Skip reloads caused by our own drag-writes — Frappe already
        // shows the bar in the right place and tasks[] was updated in memory.
        if (this.pendingWrites.delete(file.path)) return;
        await this.reload(true);
      })
    );
    // metadataCache "changed" does not fire for renames or deletions —
    // without these, a renamed task keeps its old name (and a deleted
    // task keeps its bar) until some other edit triggers a reload.
    this.registerEvent(
      this.app.vault.on("rename", () => { void this.reload(true); })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => { void this.reload(true); })
    );
  }

  async onClose(): Promise<void> { this.gantt = null; }

  // ── Shell ──────────────────────────────────────────────────────────────────

  private buildShell(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("task-gantt-root");

    const toolbar = root.createDiv({ cls: "task-gantt-toolbar" });

    // Status filter
    const label = toolbar.createEl("label", { cls: "task-gantt-label" });
    label.createSpan({ text: "Status:" });
    this.filterSelect = label.createEl("select", {
      cls: ["dropdown", "task-gantt-select"],
    });
    this.filterSelect.addEventListener("change", () => {
      this.statusFilter = this.filterSelect.value;
      this.plugin.settings.statusFilter = this.statusFilter;
      void this.plugin.saveSettings();
      this.redraw();
    });

    // View mode buttons
    const modeGroup = toolbar.createDiv({ cls: "task-gantt-mode-group" });
    for (const mode of ["Day", "Week", "Month"] as ViewMode[]) {
      const btn = modeGroup.createEl("button", {
        text: mode,
        cls: "task-gantt-mode-btn" + (mode === this.viewMode ? " active" : ""),
      });
      this.modeButtons.set(mode, btn);
      btn.addEventListener("click", () => this.setViewMode(mode));
    }

    // Today button — scroll the chart back to the current date
    toolbar.createEl("button", {
      text: "Today",
      cls: "task-gantt-today-btn",
      attr: { title: "Scroll to today" },
    }).addEventListener("click", () => {
      this.jumpToToday(this.computeTodayX(this.getFiltered()));
    });

    // Refresh button (pushed to the far right via CSS)
    toolbar.createEl("button", {
      text: "↻",
      cls: "task-gantt-refresh-btn",
      attr: { title: "Refresh" },
    }).addEventListener("click", () => { void this.reload(); });

    this.container = root.createDiv({ cls: "task-gantt-container" });
  }

  /**
   * Per-status bar colors (settings-driven, applies without redraw).
   * Sets a CSS variable + marker class on each bar wrapper; the actual
   * fill rule lives in styles.css (no style element — guideline).
   */
  private applyStatusColors(): void {
    const s = this.plugin.settings;
    const byId = new Map(this.tasks.map((t) => [t.id, t]));
    this.contentEl.querySelectorAll<SVGGElement>(".bar-wrapper").forEach((w) => {
      const t = byId.get(w.getAttribute("data-id") ?? "");
      const hex = t ? s.statusColors[t.status.toLowerCase()] ?? "" : "";
      if (s.colorByStatus && /^#[0-9a-fA-F]{6}$/.test(hex)) {
        w.classList.add("task-gantt-status-colored");
        w.style.setProperty("--task-gantt-status-color", hex);
      } else {
        w.classList.remove("task-gantt-status-colored");
        w.style.removeProperty("--task-gantt-status-color");
      }
    });
  }

  /** Called by the plugin when settings change while the view is open. */
  async refreshFromSettings(): Promise<void> {
    this.applyStatusColors();
    await this.reload(true);
  }

  /**
   * Marks a path as our own write so the "changed" handler skips it.
   * Expires after 2s — if our write's changed-event never arrives, a stale
   * entry must not swallow a future external edit to the same file.
   */
  private markPendingWrite(path: string): void {
    this.pendingWrites.add(path);
    window.setTimeout(() => this.pendingWrites.delete(path), 2000);
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  async reload(preserveScroll = false): Promise<void> {
    const fresh = await loadTaskNotes(
      this.app,
      taskSourceOptions(this.plugin.settings)
    );
    // Auto-triggered reloads (preserveScroll): skip the redraw entirely when
    // no task data actually changed — e.g. typing in a note body or editing
    // unrelated notes. Kills the flicker; manual ↻ always redraws.
    if (preserveScroll && JSON.stringify(fresh) === JSON.stringify(this.tasks)) return;
    this.tasks = fresh;
    this.rebuildFilterOptions();
    this.redraw(preserveScroll);
  }

  private redraw(preserveScroll = false): void {
    const filtered = this.getFiltered();
    if (filtered.length === 0) {
      this.showEmpty();
    } else {
      this.drawGantt(filtered, preserveScroll);
    }
  }

  private getFiltered(): TaskNote[] {
    if (!this.statusFilter) return this.tasks;
    return this.tasks.filter(
      (t) => t.status.toLowerCase() === this.statusFilter.toLowerCase()
    );
  }

  private rebuildFilterOptions(): void {
    const statuses = collectStatuses(this.tasks);
    const prev = this.statusFilter;

    this.filterSelect.empty();
    for (const s of statuses) {
      const count = this.tasks.filter(
        (t) => t.status.toLowerCase() === s.toLowerCase()
      ).length;
      this.filterSelect.createEl("option", { value: s, text: `${s} (${count})` });
    }

    const canonical = statuses.find((s) => s.toLowerCase() === prev.toLowerCase());
    if (canonical) {
      this.statusFilter = canonical;
      this.filterSelect.value = canonical;
    } else {
      const def = this.plugin.settings.defaultStatus.trim().toLowerCase();
      const preferred = def
        ? statuses.find((s) => s.toLowerCase() === def)
        : undefined;
      this.statusFilter = preferred ?? statuses[0] ?? "";
      this.filterSelect.value = this.statusFilter;
    }
  }

  // ── View mode ──────────────────────────────────────────────────────────────

  private setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.plugin.settings.viewMode = mode;
    void this.plugin.saveSettings();
    this.modeButtons.forEach((btn, m) => btn.toggleClass("active", m === mode));
    this.redraw();
  }

  // ── Gantt ──────────────────────────────────────────────────────────────────

  private drawGantt(tasks: TaskNote[], preserveScroll = false): void {
    // Capture scroll position of the old chart before it is destroyed
    const prevGc = this.container.querySelector(".gantt-container");
    const saved = preserveScroll && prevGc
      ? { left: prevGc.scrollLeft, top: prevGc.scrollTop }
      : null;

    this.container.empty();
    const svgWrapper = this.container.createDiv({ cls: "task-gantt-svg-wrapper" });

    const frappeTasks: FrappeTask[] = tasks.map((t) => ({
      id:           t.id,
      name:         t.client ? `${t.name}  · ${t.client}` : t.name,
      start:        t.start,
      end:          t.end,
      progress:     t.progress,
      custom_class: `status-${slugify(t.status)}`,
    }));

    this.gantt = new Gantt(svgWrapper, frappeTasks, {
      view_mode:   this.viewMode,
      date_format: "YYYY-MM-DD",
      popup:       false,
      bar_height:  28,
      padding:     24,

      on_date_change: async (task: FrappeTask, start: Date, end: Date) => {
        this.lastDragEnd = Date.now();
        const newStart = formatDate(start);
        const newEnd   = formatDate(end);
        // Keep in-memory state correct and mark the write as ours so the
        // metadataCache "changed" event doesn't trigger a full redraw.
        const t = this.tasks.find((x) => x.id === task.id);
        if (t) { t.start = newStart; t.end = newEnd; }
        this.addTooltips();
        this.markPendingWrite(task.id);
        const props = datePropertyNames(this.plugin.settings);
        await updateTaskDates(this.app, task.id, newStart, newEnd, props.start, props.end);
      },

      on_progress_change: async (task: FrappeTask, progress: number) => {
        this.lastDragEnd = Date.now();
        const t = this.tasks.find((x) => x.id === task.id);
        if (t) t.progress = progress;
        this.addTooltips();
        this.markPendingWrite(task.id);
        await updateTaskProgress(this.app, task.id, progress);
      },
    });

    this.addTooltips();
    this.applyStatusColors();
    this.shadeWeekends(tasks);

    const todayX = this.computeTodayX(tasks);
    this.injectTodayLine(todayX);
    window.setTimeout(() => {
      if (saved) {
        const gc = this.contentEl.querySelector(".gantt-container");
        if (gc) { gc.scrollLeft = saved.left; gc.scrollTop = saved.top; }
      } else {
        this.jumpToToday(todayX);
      }
    }, 50);
  }

  // ── Bar context menu ───────────────────────────────────────────────────────

  /** Status picker (custom statuses from settings + in-scope note statuses) + open note. */
  private showBarMenu(evt: MouseEvent, task: TaskNote): void {
    const menu = new Menu();
    const s = this.plugin.settings;
    // Custom statuses (settings) first, in the user's order, then any
    // other status found on in-scope notes (already sorted). Deduped
    // case-insensitively — the settings casing wins.
    const seen = new Map<string, string>();
    for (const st of s.customStatuses) {
      if (st && !seen.has(st.toLowerCase())) seen.set(st.toLowerCase(), st);
    }
    for (const st of collectVaultStatuses(this.app, taskSourceOptions(s))) {
      if (!seen.has(st.toLowerCase())) seen.set(st.toLowerCase(), st);
    }
    for (const status of seen.values()) {
      menu.addItem((item) =>
        item
          .setTitle(status)
          .setChecked(status.toLowerCase() === task.status.toLowerCase())
          .onClick(() => {
            // No markPendingWrite: the metadataCache reload must run so
            // bar colors and filter counts pick up the new status.
            void updateTaskStatus(this.app, task.id, status);
          })
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Open note")
        .setIcon("file-text")
        .onClick(() => this.openTaskNote(task.id))
    );
    menu.showAtMouseEvent(evt);
  }

  private openTaskNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    // Already open in a tab? Focus it instead of opening a duplicate
    // (also absorbs the second click of a double-click).
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.getViewState().state?.file === path) {
        void this.app.workspace.revealLeaf(leaf);
        return;
      }
    }
    void this.app.workspace.getLeaf("tab").openFile(file);
  }

  // ── Tooltips ───────────────────────────────────────────────────────────────

  /**
   * Native SVG <title> tooltip per bar: hover shows full name, client,
   * dates, status, progress — covers clipped/off-screen labels without
   * fighting Frappe's popup machinery. Re-run after drags to stay fresh.
   */
  private addTooltips(): void {
    const byId = new Map(this.tasks.map((t) => [t.id, t]));
    this.contentEl.querySelectorAll<SVGGElement>(".bar-wrapper").forEach((w) => {
      const t = byId.get(w.getAttribute("data-id") ?? "");
      if (!t) return;
      let title = w.querySelector<SVGTitleElement>(":scope > title");
      if (!title) {
        title = createSvg("title");
        w.insertBefore(title, w.firstChild);
      }
      const lines = [t.name];
      if (t.client) lines.push(t.client);
      lines.push(`${t.start} → ${t.end}`);
      if (t.status) lines.push(t.status);
      if (t.progress) lines.push(`${t.progress}%`);
      title.textContent = lines.join("\n");
    });
  }

  // ── Weekend shading (Day view) ─────────────────────────────────────────────

  /** Tints Sat/Sun columns. Rects go into Frappe's g.grid layer → under bars. */
  private shadeWeekends(tasks: TaskNote[]): void {
    if (this.viewMode !== "Day" || tasks.length === 0) return;
    const svg  = this.contentEl.querySelector("svg.gantt");
    const grid = svg?.querySelector("g.grid");
    if (!svg || !grid) return;

    const COL_W    = 38; // Frappe Day column width
    const HEADER_H = 60; // Frappe: header_height (50) + 10
    const width    = parseFloat(svg.getAttribute("width") ?? "0");
    const height   = parseFloat(svg.getAttribute("height") ?? "0");

    // Same ganttStart as computeTodayX Day view: earliest start − 1 month
    const earliestMs = Math.min(...tasks.map((t) => dateFromYmd(t.start).getTime()));
    const e   = new Date(earliestMs);
    const cur = new Date(e.getFullYear(), e.getMonth() - 1, e.getDate());

    const days = Math.ceil(width / COL_W);
    for (let i = 0; i < days; i++) {
      const dow = cur.getDay();
      if (dow === 0 || dow === 6) {
        const rect = createSvg("rect");
        rect.setAttribute("class", "task-gantt-weekend");
        rect.setAttribute("x", String(i * COL_W));
        rect.setAttribute("y", String(HEADER_H));
        rect.setAttribute("width", String(COL_W));
        rect.setAttribute("height", String(Math.max(0, height - HEADER_H)));
        grid.appendChild(rect);
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  // ── Today X ────────────────────────────────────────────────────────────────

  private computeTodayX(tasks: TaskNote[]): number {
    if (tasks.length === 0) return 0;

    // Component-based parse — new Date("YYYY-MM-DD") is UTC midnight and
    // would shift ganttStart (and the today line) one day west of UTC
    const earliestMs = Math.min(...tasks.map((t) => dateFromYmd(t.start).getTime()));
    const e = new Date(earliestMs);
    let ganttStart = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 0, 0, 0, 0);

    if (this.viewMode === "Month") {
      ganttStart = new Date(ganttStart.getFullYear(), 0, 1, 0, 0, 0, 0);
    } else {
      ganttStart = new Date(
        ganttStart.getFullYear(),
        ganttStart.getMonth() - 1,
        ganttStart.getDate(),
        0, 0, 0, 0
      );
    }

    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    if (this.viewMode === "Month") {
      const COL_W = 120;
      const cur   = new Date(ganttStart.getFullYear(), ganttStart.getMonth(), 1, 0, 0, 0, 0);
      const tms   = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
      let x = 0;
      while (cur.getTime() < tms.getTime()) {
        x += (daysInMonth(cur.getFullYear(), cur.getMonth()) * COL_W) / 30;
        cur.setMonth(cur.getMonth() + 1);
      }
      const dim = daysInMonth(today.getFullYear(), today.getMonth());
      x += ((today.getDate() - 1) / dim) * ((dim * COL_W) / 30);
      return x;
    } else {
      const step     = this.viewMode === "Week" ? 24 * 7 : 24;
      const colWidth = this.viewMode === "Week" ? 140 : 38;
      const hours    = Math.floor((today.getTime() - ganttStart.getTime()) / 3_600_000);
      return (hours / step) * colWidth;
    }
  }

  private injectTodayLine(x: number): void {
    const svg = this.contentEl.querySelector("svg.gantt");
    if (!svg) return;
    svg.querySelector(".task-gantt-today-line")?.remove();
    const h = parseFloat(svg.getAttribute("height") ?? "500");
    const line = createSvg("line");
    line.setAttribute("class", "task-gantt-today-line");
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x));
    line.setAttribute("y1", "0");
    line.setAttribute("y2", String(h));
    svg.appendChild(line);
  }

  private jumpToToday(x: number, attempts = 10): void {
    const gc = this.contentEl.querySelector(".gantt-container");
    if (!gc) return;
    const target = Math.max(0, x - gc.clientWidth / 2);
    gc.scrollLeft = target;
    // On first open the leaf may not be laid out yet (clientWidth 0 /
    // scrollWidth too small) — scrollLeft gets clamped and today ends up
    // off-center. Verify and retry until layout settles (max ~500ms).
    const settled = gc.clientWidth > 0 && Math.abs(gc.scrollLeft - target) < 2;
    if (!settled && attempts > 0) {
      window.setTimeout(() => this.jumpToToday(x, attempts - 1), 50);
    }
  }

  // ── Empty ──────────────────────────────────────────────────────────────────

  private showEmpty(): void {
    this.container.empty();
    const msg = this.container.createDiv({ cls: "task-gantt-empty" });
    msg.createEl("p", { text: "No tasks found matching the current filter." });
    const props = datePropertyNames(this.plugin.settings);
    msg.createEl("p", {
      text: `Add ${props.start} and ${props.end} (YYYY-MM-DD) to your task note frontmatter.`,
      cls: "task-gantt-empty-hint",
    });
    const s = this.plugin.settings;
    if (s.sourceFolder || s.requiredProperty) {
      msg.createEl("p", {
        text: "Note: folder/property filters are active in the plugin settings.",
        cls: "task-gantt-empty-hint",
      });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Timezone-safe YYYY-MM-DD → local Date (never new Date(string)) */
function dateFromYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
