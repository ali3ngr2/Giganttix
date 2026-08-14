import {
  AbstractInputSuggest,
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  debounce,
} from "obsidian";
import { GanttView, GANTT_VIEW_TYPE } from "./GanttView";
import {
  loadTaskNotes,
  collectStatuses,
  collectVaultStatuses,
  TaskSourceOptions,
} from "./taskParser";

export type ViewMode = "Day" | "Week" | "Month";

export interface TaskGanttSettings {
  viewMode: ViewMode;       // last-used view (sticky)
  statusFilter: string;     // last-used filter (sticky)
  rememberLast: boolean;    // true: open with last-used; false: open with defaults
  defaultViewMode: ViewMode;
  defaultStatus: string;    // "" → first available status
  colorByStatus: boolean;   // false → theme accent color for all bars
  statusColors: Record<string, string>; // lowercase status → hex
  sourceFolder: string;     // "" → whole vault
  requiredProperty: string; // "" → no property requirement
  startProperty: string;    // "" → "startDate"
  endProperty: string;      // "" → "endDate"
  projectProperty: string;  // "" → no project filter
  customStatuses: string[]; // always offered in the bar menu, in this order
}

const DEFAULT_SETTINGS: TaskGanttSettings = {
  viewMode: "Week",
  statusFilter: "",
  rememberLast: true,
  defaultViewMode: "Week",
  defaultStatus: "",
  colorByStatus: false,
  statusColors: {},
  sourceFolder: "",
  requiredProperty: "",
  startProperty: "",
  endProperty: "",
  projectProperty: "",
  customStatuses: [],
};

/** Effective frontmatter property names ("" → defaults). */
export function datePropertyNames(s: TaskGanttSettings): { start: string; end: string } {
  return {
    start: s.startProperty.trim() || "startDate",
    end: s.endProperty.trim() || "endDate",
  };
}

/**
 * Loader/scanner options derived from settings — single source of truth
 * so the chart, the status menu, and the settings tab can't drift apart
 * on scoping.
 */
export function taskSourceOptions(s: TaskGanttSettings): TaskSourceOptions {
  return {
    sourceFolder: s.sourceFolder,
    requiredProperty: s.requiredProperty,
    startProperty: s.startProperty,
    endProperty: s.endProperty,
    projectProperty: s.projectProperty,
  };
}

export default class TaskGanttPlugin extends Plugin {
  settings: TaskGanttSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<TaskGanttSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    this.registerView(
      GANTT_VIEW_TYPE,
      (leaf) => new GanttView(leaf, this)
    );

    this.addSettingTab(new TaskGanttSettingTab(this.app, this));

    this.addRibbonIcon("gantt-chart", "Open Giganttix", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open", // Obsidian prefixes the plugin id automatically
      name: "Open Gantt view",
      callback: () => this.activateView(),
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Push settings changes to any open Gantt views immediately. */
  refreshGanttViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(GANTT_VIEW_TYPE)) {
      if (leaf.view instanceof GanttView) void leaf.view.refreshFromSettings();
    }
  }

  // NOTE: no detachLeavesOfType in onunload — Obsidian manages leaves
  // itself; detaching them on unload is an explicit guideline violation.

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(GANTT_VIEW_TYPE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: GANTT_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }
}

class TaskGanttSettingTab extends PluginSettingTab {
  /** Statuses on charted tasks — drives the per-status color pickers. */
  private taskStatuses: string[] = [];
  /** Statuses on in-scope notes — feeds the status field suggestions. */
  private vaultStatusCache: string[] = [];

  constructor(app: App, private plugin: TaskGanttPlugin) {
    super(app, plugin);
    // getSettingDefinitions() runs on every tab update AND once at
    // registration to index settings for search, so it must stay cheap.
    // The vault scan therefore happens here and the result is cached.
    void this.refreshStatusCache();
    const refresh = debounce(() => void this.refreshStatusCache(), 300, true);
    plugin.registerEvent(this.app.vault.on("create", refresh));
    plugin.registerEvent(this.app.vault.on("delete", refresh));
    plugin.registerEvent(this.app.vault.on("rename", refresh));
    plugin.registerEvent(this.app.metadataCache.on("changed", refresh));
  }

  private async refreshStatusCache(): Promise<void> {
    const opts = taskSourceOptions(this.plugin.settings);
    this.taskStatuses = collectStatuses(await loadTaskNotes(this.app, opts));
    this.vaultStatusCache = collectVaultStatuses(this.app, opts);
    this.update();
  }

  /**
   * Declarative controls write to plugin.settings and persist on our behalf.
   * Overriding the write path lets open Gantt views refresh too — the default
   * implementation only calls saveData().
   */
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.save();
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.refreshGanttViews();
  }

  getSettingDefinitions() {
    const s = this.plugin.settings;

    return [
      // ── Opening behavior (general — no heading, per the style guide) ──
      {
        name: "Default view",
        desc: "View mode the Gantt opens with.",
        control: {
          type: "dropdown" as const,
          key: "defaultViewMode",
          options: { Day: "Day", Week: "Week", Month: "Month" },
        },
      },
      {
        name: "Default status filter",
        desc: "Status selected when the Gantt opens, matched case-insensitively. Leave empty to select the first available status.",
        control: {
          type: "text" as const,
          key: "defaultStatus",
          placeholder: "e.g. In progress",
        },
      },
      {
        name: "Remember last used view and filter",
        desc: "On: reopening restores your last view mode and status filter. Off: always open with the defaults above.",
        control: { type: "toggle" as const, key: "rememberLast" },
      },

      // ── Task source ──
      {
        type: "group" as const,
        heading: "Task source",
        items: [
          {
            name: "Folder",
            desc: "Only show notes from this folder (subfolders included). Leave empty to scan the whole vault.",
            control: {
              type: "folder" as const,
              key: "sourceFolder",
              placeholder: "Whole vault",
            },
          },
          {
            name: "Required property",
            desc: 'Only show notes whose frontmatter contains this property. Use "name: value" to also require a specific value.',
            control: {
              type: "text" as const,
              key: "requiredProperty",
              placeholder: "e.g. Kind: Project",
            },
          },
          {
            name: "Start date property",
            desc: 'Frontmatter property holding the task start date. Leave empty to use "startDate". Drags write dates back to this property.',
            control: {
              type: "text" as const,
              key: "startProperty",
              placeholder: "startDate",
            },
          },
          {
            name: "End date property",
            desc: 'Frontmatter property holding the task end date. Leave empty to use "endDate".',
            control: {
              type: "text" as const,
              key: "endProperty",
              placeholder: "endDate",
            },
          },
          {
            name: "Project property",
            desc: "Frontmatter property to group tasks by. When set, a project filter appears in the chart toolbar.",
            control: {
              type: "text" as const,
              key: "projectProperty",
              placeholder: "e.g. project",
            },
          },
        ],
      },

      // ── Statuses ──
      {
        type: "list" as const,
        heading: "Statuses",
        emptyState:
          "No statuses defined. Added statuses are always offered in the bar right-click menu, in this order.",
        addItem: {
          name: "Add status",
          action: () => {
            s.customStatuses.push("");
            void this.save();
            this.update();
          },
        },
        onReorder: async (oldIndex: number, newIndex: number) => {
          const [moved] = s.customStatuses.splice(oldIndex, 1);
          s.customStatuses.splice(newIndex, 0, moved);
          await this.save();
        },
        onDelete: async (index: number) => {
          s.customStatuses.splice(index, 1);
          await this.save();
          this.update();
        },
        items: s.customStatuses.map((value, i) => ({
          name: "",
          searchable: false,
          // AbstractInputSuggest has no declarative control type, so the
          // type-ahead field is built imperatively here.
          render: (setting: Setting) => {
            setting.addText((t) => {
              t.setPlaceholder("e.g. In progress").setValue(value);
              const suggest = new StatusSuggest(
                this.app,
                t.inputEl,
                () => this.vaultStatusCache
              );
              suggest.onSelect((v) => {
                t.setValue(v);
                suggest.close();
                s.customStatuses[i] = v;
                void this.save();
              });
              t.onChange((v) => {
                s.customStatuses[i] = v;
                void this.save();
              });
            });
          },
        })),
      },

      // ── Appearance ──
      {
        type: "group" as const,
        heading: "Appearance",
        items: [
          {
            name: "Color bars by status",
            desc: "Off: all bars use your theme's accent color. On: pick a color per status below.",
            control: { type: "toggle" as const, key: "colorByStatus" },
          },
          ...this.taskStatuses.map((status) => ({
            name: status,
            visible: () => s.colorByStatus,
            render: (setting: Setting) => {
              const key = status.toLowerCase();
              setting
                .addColorPicker((cp) =>
                  cp
                    .setValue(s.statusColors[key] ?? "#999999")
                    .onChange((v) => {
                      s.statusColors[key] = v;
                      void this.save();
                    })
                )
                .addExtraButton((b) =>
                  b
                    .setIcon("rotate-ccw")
                    .setTooltip("Reset to theme accent color")
                    .onClick(() => {
                      delete s.statusColors[key];
                      void this.save();
                      this.update();
                    })
                );
            },
          })),
        ],
      },
    ];
  }
}
/** Suggests existing vault statuses while typing in a status field. */
class StatusSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly source: () => string[]
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.source().filter((s) => s.toLowerCase().includes(q));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}
