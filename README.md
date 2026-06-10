# ObsiGantt
Visualise your task notes as a draggable Gantt chart in Obsidian

ObsiGantt scans your vault for notes with date frontmatter and renders them as an interactive timeline. Each note is one bar. Drag a bar to reschedule the task & the new dates are written back to the note's frontmatter. Click a bar to open the note.

Originally built as a companion to [TaskNotes](https://github.com/callumalpass/tasknotes), but should works with any notes that carry date frontmatter, anything with a start and an end.

![ObsiGantt and TaskNotes](assets/Obsigant-tasknotes.png)

## How it works

Add dates to any note's frontmatter and it appears on the chart:

```yaml
---
startDate: 2026-06-05
endDate: 2026-06-30
status: In progress
client: "[[Moe's Tavern]]"
progress: 40
---
```

| Field | Required | Notes |
| --- | --- | --- |
| `startDate` | yes* | `YYYY-MM-DD` (also accepts slash and verbose formats) |
| `endDate` | yes* | same formats; *one of the two dates is enough (1-day bar) |
| `Status` | no | powers the status filter dropdown |
| `client` | no | shown after the task name; wikilinks display clean |
| `progress` | no | 0–100, rendered as a darker segment inside the bar |

Field names are case-insensitive. 

## Features

- **Drag to reschedule** : move or resize a bar; frontmatter updates atomically
- **Drag the progress handle** :  hover a bar and drag the small handle to set % complete, written to `progress`
- **Click a bar** to open its note
- **Day, Week & Month views**
- **Status filter** built from your actual status values
- **Tooltips** : hover any bar for full name, client, dates, status, and progress
- **Weekend shading** in Day view
- **Scope your tasks** : limit the chart to a folder and/or require a frontmatter property (e.g. only notes with a `projects` property)
- **Status colors** : keep the theme accent color, or assign a color per status in settings

![ObsiGantt](assets/Obsigantt.png)

## Usage

Open the chart from the ribbon icon or the command palette (`ObsiGantt: Open Gantt view`).

## Settings

| Setting | What it does |
| --- | --- |
| Default view | Day, Week or Month on open |
| Default status filter | Status selected on open (case-insensitive); empty = first available |
| Remember last used view and filter | On: reopening restores your last state. Off: always open with the defaults |
| Folder | Only show notes from this folder (subfolders included); empty = whole vault |
| Required property | Only show notes that have this frontmatter property, e.g. `projects` |
| Color bars by status | Off: theme accent color. On: per-status color pickers |

![Settings](assets/settings.png)

## Installation

**Community plugins:** Settings → Community plugins → Browse → search "ObsiGantt".


## Notes and limitations

- Writing dates back re-serializes the note's frontmatter block; values are untouched but formatting (quoting style) may normalize.
- The timeline is computed from the currently filtered tasks, so column positions can shift when switching filters.
- Desktop only for now.

## Acknowledgements

Built with TypeScript and esbuild on top of [Frappe Gantt](https://github.com/frappe/gantt) (MIT). Developed in collaboration with [Claude](https://claude.com) (Anthropic).

## License

[MIT](LICENSE)
