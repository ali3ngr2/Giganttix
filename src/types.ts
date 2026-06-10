export interface TaskNote {
  id: string;         // file path (unique)
  name: string;       // display name (file basename)
  start: string;      // YYYY-MM-DD
  end: string;        // YYYY-MM-DD
  status: string;     // value of "status" frontmatter field
  progress: number;   // 0–100, optional
  client: string;     // value of "client" frontmatter field
}

// Frappe Gantt task shape
export interface FrappeTask {
  id: string;
  name: string;
  start: string;
  end: string;
  progress: number;
  custom_class?: string;
}
