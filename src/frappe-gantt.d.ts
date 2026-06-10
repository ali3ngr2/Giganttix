/**
 * Minimal type declarations for frappe-gantt 0.6.x, which ships no types.
 * Only the surface this plugin actually uses is declared.
 */
declare module "frappe-gantt" {
  export interface FrappeGanttTask {
    id: string;
    name: string;
    start: string;
    end: string;
    progress: number;
    custom_class?: string;
  }

  export interface FrappeGanttOptions {
    view_mode?: "Quarter Day" | "Half Day" | "Day" | "Week" | "Month";
    date_format?: string;
    popup?: boolean | string | ((task: FrappeGanttTask) => string);
    bar_height?: number;
    padding?: number;
    on_date_change?: (
      task: FrappeGanttTask,
      start: Date,
      end: Date
    ) => void | Promise<void>;
    on_progress_change?: (
      task: FrappeGanttTask,
      progress: number
    ) => void | Promise<void>;
    on_click?: (task: FrappeGanttTask) => void;
  }

  export default class Gantt {
    constructor(
      wrapper: string | HTMLElement | SVGElement,
      tasks: FrappeGanttTask[],
      options?: FrappeGanttOptions
    );
    change_view_mode(mode: string): void;
    refresh(tasks: FrappeGanttTask[]): void;
  }
}
