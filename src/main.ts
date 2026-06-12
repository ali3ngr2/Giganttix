import {
  AbstractInputSuggest,
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
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
  /** Working copy of the status fields currently rendered (incl. empties). */
  private statusFields: string[] = [];

  constructor(app: App, private plugin: TaskGanttPlugin) {
    super(app, plugin);
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.refreshGanttViews();
  }

  /** Statuses found on in-scope notes — feeds the field suggestions. */
  private vaultStatuses(): string[] {
    return collectVaultStatuses(this.app, taskSourceOptions(this.plugin.settings));
  }

  /** Persist the status fields (trimmed, empties dropped, order kept). */
  private async saveStatusFields(): Promise<void> {
    this.plugin.settings.customStatuses = this.statusFields
      .map((v) => v.trim())
      .filter(Boolean);
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Opening behavior ──
    new Setting(containerEl)
      .setName("Default view")
      .setDesc("View mode the Gantt opens with.")
      .addDropdown((d) =>
        d
          .addOption("Day", "Day")
          .addOption("Week", "Week")
          .addOption("Month", "Month")
          .setValue(this.plugin.settings.defaultViewMode)
          .onChange(async (v) => {
            this.plugin.settings.defaultViewMode = v as ViewMode;
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("Default status filter")
      .setDesc(
        "Status selected when the Gantt opens, matched case-insensitively. " +
        "Leave empty to select the first available status."
      )
      .addText((t) =>
        t
          .setPlaceholder("e.g. In progress")
          .setValue(this.plugin.settings.defaultStatus)
          .onChange(async (v) => {
            this.plugin.settings.defaultStatus = v.trim();
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("Remember last used view and filter")
      .setDesc(
        "On: reopening the Gantt restores your last view mode and status filter. " +
        "Off: it always opens with the defaults above."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.rememberLast).onChange(async (v) => {
          this.plugin.settings.rememberLast = v;
          await this.save();
        })
      );

    // ── Task source ──
    new Setting(containerEl)
      .setName("Folder")
      .setDesc(
        "Only show notes from this folder (subfolders included). " +
        "Leave empty to scan the whole vault."
      )
      .addText((t) =>
        t
          .setPlaceholder("e.g. Tasks")
          .setValue(this.plugin.settings.sourceFolder)
          .onChange(async (v) => {
            const trimmed = v.trim();
            this.plugin.settings.sourceFolder = trimmed
              ? normalizePath(trimmed)
              : "";
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("Required property")
      .setDesc(
        "Only show notes whose frontmatter contains this property (case-insensitive). " +
        "Use \"name: value\" to also require a specific value, " +
        "e.g. \"Kind: Project\". Leave empty for no requirement."
      )
      .addText((t) =>
        t
          .setPlaceholder("e.g. Kind: Project")
          .setValue(this.plugin.settings.requiredProperty)
          .onChange(async (v) => {
            this.plugin.settings.requiredProperty = v.trim();
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("Start date property")
      .setDesc(
        "Frontmatter property holding the task start date (case-insensitive). " +
        "Leave empty to use \"startDate\". Drags write dates back to this property."
      )
      .addText((t) =>
        t
          .setPlaceholder("startDate")
          .setValue(this.plugin.settings.startProperty)
          .onChange(async (v) => {
            this.plugin.settings.startProperty = v.trim();
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("End date property")
      .setDesc(
        "Frontmatter property holding the task end date (case-insensitive). " +
        "Leave empty to use \"endDate\"."
      )
      .addText((t) =>
        t
          .setPlaceholder("endDate")
          .setValue(this.plugin.settings.endProperty)
          .onChange(async (v) => {
            this.plugin.settings.endProperty = v.trim();
            await this.save();
          })
      );

    // ── Statuses ──
    new Setting(containerEl)
      .setName("Statuses")
      .setDesc(
        "Always offered in the bar right-click menu, in this order, in " +
        "addition to statuses found on your notes. Typing suggests " +
        "existing statuses. Clear a field to remove it (empty fields " +
        "are dropped when settings reopen)."
      );

    this.statusFields = [...this.plugin.settings.customStatuses];
    while (this.statusFields.length < 4) this.statusFields.push("");

    const fieldsEl = containerEl.createDiv();
    const renderField = (value: string, i: number) => {
      new Setting(fieldsEl).addText((t) => {
        t.setPlaceholder("e.g. In progress").setValue(value);
        const suggest = new StatusSuggest(this.app, t.inputEl, () =>
          this.vaultStatuses()
        );
        suggest.onSelect((v) => {
          t.setValue(v);
          suggest.close();
          this.statusFields[i] = v;
          void this.saveStatusFields();
        });
        t.onChange(async (v) => {
          this.statusFields[i] = v;
          await this.saveStatusFields();
        });
      });
    };
    this.statusFields.forEach(renderField);

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add status").onClick(() => {
        this.statusFields.push("");
        renderField("", this.statusFields.length - 1);
      })
    );

    // ── Appearance ──
    new Setting(containerEl)
      .setName("Color bars by status")
      .setDesc(
        "Off: all bars use your theme's accent color. " +
        "On: pick a color per status below."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.colorByStatus).onChange(async (v) => {
          this.plugin.settings.colorByStatus = v;
          await this.save();
          this.display(); // show/hide the per-status pickers
        })
      );

    if (this.plugin.settings.colorByStatus) {
      const colorsEl = containerEl.createDiv();
      void this.renderStatusColorPickers(colorsEl);
    }
  }

  private async renderStatusColorPickers(el: HTMLElement): Promise<void> {
    const s = this.plugin.settings;
    const tasks = await loadTaskNotes(this.app, taskSourceOptions(s));
    const statuses = collectStatuses(tasks);

    if (statuses.length === 0) {
      el.createEl("p", {
        text: "No statuses found in your task notes yet.",
        cls: "setting-item-description",
      });
      return;
    }

    for (const status of statuses) {
      const key = status.toLowerCase();
      new Setting(el)
        .setName(status)
        .addColorPicker((cp) =>
          cp
            .setValue(s.statusColors[key] ?? "#999999")
            .onChange(async (v) => {
              s.statusColors[key] = v;
              await this.save();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("rotate-ccw")
            .setTooltip("Reset to theme accent color")
            .onClick(async () => {
              delete s.statusColors[key];
              await this.save();
              this.display();
            })
        );
    }
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
