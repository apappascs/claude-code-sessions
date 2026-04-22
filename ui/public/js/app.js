// ui/public/js/app.js

// ── API client (inlined — no ES module import needed) ──
const BASE = "/api";
async function _get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) { const b = await res.text(); throw new Error(`API ${res.status}: ${b}`); }
  return res.json();
}
const api = {
  dashboardStats: () => _get("/dashboard/stats"),
  recentSessions: (limit = 5) => _get(`/sessions?limit=${limit}&sort=recency`),
  listSessions: (params = {}) => { const q = new URLSearchParams(params).toString(); return _get(`/sessions${q ? "?" + q : ""}`); },
  sessionStats: (p) => _get(`/sessions/stats?path=${encodeURIComponent(p)}`),
  search: (query, params = {}) => { const q = new URLSearchParams({ query, ...params }).toString(); return _get(`/search?${q}`); },
  taskLists: () => _get("/tasks/lists"),
  tasks: (params = {}) => { const q = new URLSearchParams(params).toString(); return _get(`/tasks${q ? "?" + q : ""}`); },
  sessionDetail: (id) => _get(`/sessions/${encodeURIComponent(id)}`),
  sessionMessages: (id, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return _get(`/sessions/${encodeURIComponent(id)}/messages${q ? "?" + q : ""}`);
  },
  orphanTaskLists: () => _get("/tasks/orphans"),
  deleteSession: (id, deleteTasks = false) =>
    fetch(`${BASE}/sessions/${encodeURIComponent(id)}?delete_tasks=${deleteTasks}`, { method: "DELETE" })
      .then((r) => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }),
  deleteTask: (taskListId, taskId) =>
    fetch(`${BASE}/tasks/${encodeURIComponent(taskListId)}/${encodeURIComponent(taskId)}`, { method: "DELETE" })
      .then((r) => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }),
  deleteTaskList: (taskListId) =>
    fetch(`${BASE}/tasks/${encodeURIComponent(taskListId)}`, { method: "DELETE" })
      .then((r) => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }),
  chartDailyTokens: (range) => _get(`/charts/daily-tokens?since=${range}`),
  chartModelDistribution: (range) => _get(`/charts/model-distribution?since=${range}`),
  chartActivityHeatmap: (range) => _get(`/charts/activity-heatmap?since=${range}`),
};

// ── Formatting helpers ──

/** Format minutes into human-readable duration: 0s / 2m / 1h 5m */
function formatDuration(totalMinutes) {
  const m = Math.floor(totalMinutes ?? 0);
  if (m < 1) return `${Math.round((totalMinutes ?? 0) * 60)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return mins === 0 ? `${h}h` : `${h}h ${mins}m`;
}

/** Shorten a session UUID to first 8 chars */
function shortId(id) {
  if (!id) return "—";
  return String(id).slice(0, 8);
}

/** Format a date as relative time: "3m ago", "2h ago", "Apr 10" */
function relativeDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Format bytes: 500 B / 2.0 KB / 5.0 MB */
function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Truncate text with ellipsis */
function truncate(text, maxLen = 60) {
  if (!text) return "";
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

/** Format a token count: 1234 → "1.2k", 1234567 → "1.2M" */
function formatTokens(n) {
  if (n == null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/** Format a project path to a meaningful short name.
 *  Strips common prefixes (Users/<user>/...) and shows the last 2 meaningful segments.
 *  e.g. "/Users/me/workspace/my-project" → "my-project"
 */
function formatProject(project) {
  if (!project) return "—";
  // Strip leading /Users/<username>/ or similar home prefixes
  const parts = project.split("/").filter(Boolean);
  // Remove common prefix segments: Users, username, workspace, Desktop, etc.
  const skipPrefixes = new Set(["Users", "home", "var", "tmp"]);
  let start = 0;
  if (parts.length > 2 && skipPrefixes.has(parts[0])) {
    start = 2; // skip "Users/<username>"
    // Also skip generic container dirs
    while (start < parts.length - 1 && ["workspace", "projects", "repos", "code", "dev", "src", "Desktop", "Documents", "test-workspace"].includes(parts[start])) {
      start++;
    }
  }
  const meaningful = parts.slice(start);
  if (meaningful.length <= 2) return meaningful.join("/") || parts[parts.length - 1] || project;
  // Show last 2 segments
  return meaningful.slice(-2).join("/");
}

/** Sanitize error messages for user display — strip file paths and stack traces */
function sanitizeError(msg) {
  if (!msg || typeof msg !== "string") return "An error occurred";
  // Strip file paths (Unix and Windows)
  let clean = msg.replace(/\/[\w./-]+/g, "[path]").replace(/[A-Z]:\\[\w.\\-]+/g, "[path]");
  // Strip stack trace lines
  clean = clean.replace(/\s+at\s+.+/g, "");
  // Truncate to reasonable length
  if (clean.length > 200) clean = clean.slice(0, 200) + "...";
  return clean.trim() || "An error occurred";
}

/** Read a CSS custom property value from :root */
function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// formatTokenCount is an alias for formatTokens (used by chart axis callbacks)
const formatTokenCount = formatTokens;

document.addEventListener("alpine:init", () => {
  // Global store for the app
  Alpine.store("app", {
    view: "dashboard",
    sessionId: null,
    taskPanel: null,
    toast: null,
    loading: false,

    navigate(view, params) {
      if (view.startsWith("session/")) {
        this.sessionId = view.slice(8);
        this.view = "session-detail";
        window.location.hash = view;
      } else {
        this.sessionId = null;
        this.view = view;
        window.location.hash = view;
      }
    },

    openTaskPanel(taskListId, taskId, tasks) {
      this.taskPanel = { taskListId, taskId, tasks };
    },

    closeTaskPanel() {
      this.taskPanel = null;
    },

    showToast(message, type = "info") {
      this.toast = { message, type };
      setTimeout(() => { this.toast = null; }, 3000);
    },

    init() {
      const hash = window.location.hash.slice(1);
      if (hash.startsWith("session/")) {
        this.sessionId = hash.slice(8);
        this.view = "session-detail";
      } else if (["dashboard", "sessions", "search", "tasks"].includes(hash)) {
        this.view = hash;
      }
      window.addEventListener("hashchange", () => {
        const h = window.location.hash.slice(1);
        if (h.startsWith("session/")) {
          this.sessionId = h.slice(8);
          this.view = "session-detail";
        } else if (["dashboard", "sessions", "search", "tasks"].includes(h)) {
          this.sessionId = null;
          this.view = h;
        }
      });
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.taskPanel) {
          this.closeTaskPanel();
        }
      });
    },
  });

  Alpine.store("charts", {
    range: "30d",
    dailyTokens: null,
    modelDistribution: null,
    activityHeatmap: null,
    loading: { tokens: false, models: false, heatmap: false },
    _chartInstances: { token: null, model: null },

    async setRange(range) {
      this.range = range;
      await this.fetchAll();
    },

    async fetchAll() {
      this.loading = { tokens: true, models: true, heatmap: true };

      const range = this.range;

      // Parallel fetch
      const [tokens, models, heatmap] = await Promise.allSettled([
        api.chartDailyTokens(range),
        api.chartModelDistribution(range),
        api.chartActivityHeatmap(range),
      ]);

      this.dailyTokens = tokens.status === "fulfilled" ? tokens.value : null;
      this.loading.tokens = false;

      this.modelDistribution = models.status === "fulfilled" ? models.value : null;
      this.loading.models = false;

      this.activityHeatmap = heatmap.status === "fulfilled" ? heatmap.value : null;
      this.loading.heatmap = false;
    },

    destroyCharts() {
      if (this._chartInstances.token) { this._chartInstances.token.destroy(); this._chartInstances.token = null; }
      if (this._chartInstances.model) { this._chartInstances.model.destroy(); this._chartInstances.model = null; }
    },
  });

  // Make formatters available globally in Alpine templates
  window.fmt = {
    formatDuration,
    formatCount: formatTokens,
    shortId,
    relativeDate,
    relativeTime: relativeDate,
    formatSize,
    truncate,
    formatTokens,
    formatProject,
  };

  // Dashboard data
  Alpine.data("dashboard", () => ({
    stats: null,
    recentSessions: [],
    pendingTasks: [],
    loading: true,
    error: null,

    async init() {
      this.loading = true;
      this.error = null;
      try {
        const [stats, sessions, tasks] = await Promise.all([
          api.dashboardStats(),
          api.recentSessions(5),
          api.tasks({ status: "pending" }),
        ]);
        this.stats = stats;
        this.recentSessions = sessions;
        this.pendingTasks = tasks.slice(0, 5);
      } catch (e) {
        console.error("Dashboard load failed:", e);
        this.error = "Failed to load dashboard data. Is the server running?";
      }
      this.loading = false;
    },
  }));

  // Sessions list data
  Alpine.data("sessionsList", () => ({
    allSessions: [],
    loading: true,
    error: null,
    sortField: "last_activity",
    sortDir: "desc",
    projectFilter: "",
    page: 1,
    pageSize: 25,
    selected: new Set(),
    deleting: false,

    async init() {
      await this.load();
      // Clear selection when filter or page changes
      this.$watch("projectFilter", () => { this.selected = new Set(); });
      this.$watch("page", () => { this.selected = new Set(); });
    },

    get sorted() {
      const field = this.sortField;
      const dir = this.sortDir === "asc" ? 1 : -1;
      return [...this.allSessions].sort((a, b) => {
        let va = a[field], vb = b[field];
        if (va == null) va = "";
        if (vb == null) vb = "";
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    },

    get filtered() {
      if (!this.projectFilter) return this.sorted;
      const q = this.projectFilter.toLowerCase();
      return this.sorted.filter(s => (s.project || "").toLowerCase().includes(q));
    },

    get totalPages() {
      return Math.max(1, Math.ceil(this.filtered.length / this.pageSize));
    },

    get sessions() {
      const start = (this.page - 1) * this.pageSize;
      return this.filtered.slice(start, start + this.pageSize);
    },

    get totalCount() {
      return this.filtered.length;
    },

    get allSelected() {
      if (this.sessions.length === 0) return false;
      return this.sessions.every(s => this.selected.has(s.session_id));
    },

    get selectionCount() {
      return this.selected.size;
    },

    toggleAll() {
      if (this.allSelected) {
        // Deselect all on current page
        for (const s of this.sessions) {
          this.selected.delete(s.session_id);
        }
      } else {
        // Select all on current page
        for (const s of this.sessions) {
          this.selected.add(s.session_id);
        }
      }
      // Trigger reactivity by reassigning
      this.selected = new Set(this.selected);
    },

    toggleSelect(sessionId) {
      if (this.selected.has(sessionId)) {
        this.selected.delete(sessionId);
      } else {
        this.selected.add(sessionId);
      }
      this.selected = new Set(this.selected);
    },

    isSelected(sessionId) {
      return this.selected.has(sessionId);
    },

    clearSelection() {
      this.selected = new Set();
    },

    bulkDeleteConfirm: false,

    async deleteSelected(deleteTasks) {
      const count = this.selected.size;
      if (count === 0) return;

      this.deleting = true;
      let errors = 0;
      const ids = [...this.selected];
      for (const id of ids) {
        try {
          await api.deleteSession(id, deleteTasks);
        } catch (e) {
          errors++;
          console.error(`Failed to delete session ${id}:`, e);
        }
      }

      this.selected = new Set();
      this.bulkDeleteConfirm = false;
      await this.load();
      this.deleting = false;

      if (errors > 0) {
        Alpine.store("app").showToast(`Deleted ${count - errors} session${count - errors !== 1 ? "s" : ""}. ${errors} failed.`, "error");
      } else {
        Alpine.store("app").showToast(`Deleted ${count} session${count > 1 ? "s" : ""}`);
      }
    },

    toggleSort(field) {
      if (this.sortField === field) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortField = field;
        this.sortDir = field === "messages" || field === "duration_minutes" || field === "size_bytes" ? "desc" : "desc";
      }
      this.page = 1;
    },

    sortIcon(field) {
      if (this.sortField !== field) return "";
      return this.sortDir === "asc" ? " \u25B2" : " \u25BC";
    },

    prevPage() { if (this.page > 1) this.page--; },
    nextPage() { if (this.page < this.totalPages) this.page++; },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        this.allSessions = await api.listSessions({ sort: "recency", limit: 9999 });
        this.page = 1;
      } catch (e) {
        console.error("Sessions load failed:", e);
        this.error = "Failed to load sessions.";
      }
      this.loading = false;
    },
  }));

  // Search data
  Alpine.data("searchView", () => ({
    query: "",
    results: [],
    loading: false,
    searched: false,
    error: null,

    async doSearch() {
      if (!this.query.trim()) return;
      this.loading = true;
      this.searched = true;
      this.error = null;
      try {
        this.results = await api.search(this.query, { limit: 30, context: 1 });
      } catch (e) {
        console.error("Search failed:", e);
        this.error = "Search failed. Please try again.";
      }
      this.loading = false;
    },
  }));

  // Tasks data
  Alpine.data("tasksView", () => ({
    tasks: [],
    taskLists: [],
    orphans: [],
    showOrphans: false,
    loading: true,
    statusFilter: "all",
    collapsed: { in_progress: false, pending: true, completed: true },

    async init() {
      this.loading = true;
      try {
        const [tasks, lists, orphans] = await Promise.all([
          api.tasks(),
          api.taskLists(),
          api.orphanTaskLists(),
        ]);
        this.tasks = tasks;
        this.taskLists = lists;
        this.orphans = orphans;
      } catch (e) {
        console.error("Tasks load failed:", e);
      }
      this.loading = false;
    },

    async inspectOrphan(taskListId) {
      try {
        const tasks = await api.tasks({ task_list: taskListId });
        if (tasks.length > 0) {
          Alpine.store("app").taskPanel = { taskListId, taskId: tasks[0].id, tasks, isOrphan: true };
        } else {
          Alpine.store("app").showToast("No tasks in this list");
        }
      } catch (e) {
        console.error("Failed to load orphan tasks:", e);
      }
    },

    async deleteOrphan(taskListId) {
      try {
        await api.deleteTaskList(taskListId);
        this.orphans = this.orphans.filter((o) => o.task_list_id !== taskListId);
        Alpine.store("app").showToast("Orphan task list deleted");
      } catch (e) {
        Alpine.store("app").showToast("Delete failed", "error");
      }
    },

    async deleteAllOrphans() {
      for (const o of [...this.orphans]) {
        try {
          await api.deleteTaskList(o.task_list_id);
        } catch { /* continue */ }
      }
      this.orphans = [];
      Alpine.store("app").showToast("All orphan task lists deleted");
    },

    get filteredTasks() {
      const validStatuses = ["in_progress", "pending", "completed"];
      const active = this.tasks.filter((t) => validStatuses.includes(t.status));
      if (this.statusFilter === "all") return active;
      return active.filter((t) => t.status === this.statusFilter);
    },

    get grouped() {
      const groups = { in_progress: [], pending: [], completed: [] };
      for (const t of this.filteredTasks) {
        if (groups[t.status]) {
          groups[t.status].push(t);
        }
        // Skip tasks with unknown status (e.g. "deleted", undefined)
      }
      return groups;
    },
  }));

  // Session detail data
  Alpine.data("sessionDetail", () => ({
    detail: null,
    messages: [],
    messagesTotal: 0,
    messagesHasMore: false,
    showTools: false,
    loading: true,
    loadingMore: false,
    error: null,
    deleteConfirm: false,
    deleting: false,

    async init() {
      this.loading = true;
      const sessionId = Alpine.store("app").sessionId;
      if (!sessionId) {
        this.error = "No session ID provided.";
        this.loading = false;
        return;
      }
      try {
        const [detail, msgResult] = await Promise.all([
          api.sessionDetail(sessionId),
          api.sessionMessages(sessionId, { limit: "100", offset: "0", include_tools: "false" }),
        ]);
        this.detail = detail;
        this.messages = msgResult.messages;
        this.messagesTotal = msgResult.total;
        this.messagesHasMore = msgResult.hasMore;
      } catch (e) {
        this.error = "Session not found — it may have been deleted.";
        console.error("Session detail load failed:", e);
      }
      this.loading = false;
    },

    async loadMore() {
      if (this.loadingMore || !this.messagesHasMore) return;
      this.loadingMore = true;
      const sessionId = Alpine.store("app").sessionId;
      try {
        const result = await api.sessionMessages(sessionId, {
          limit: "100",
          offset: String(this.messages.length),
          include_tools: String(this.showTools),
        });
        this.messages = [...this.messages, ...result.messages];
        this.messagesHasMore = result.hasMore;
      } catch (e) {
        console.error("Load more failed:", e);
      }
      this.loadingMore = false;
    },

    async toggleTools() {
      this.showTools = !this.showTools;
      const sessionId = Alpine.store("app").sessionId;
      try {
        const result = await api.sessionMessages(sessionId, {
          limit: String(this.messages.length),
          offset: "0",
          include_tools: String(this.showTools),
        });
        this.messages = result.messages;
        this.messagesHasMore = result.hasMore;
      } catch (e) {
        console.error("Toggle tools reload failed:", e);
      }
    },

    async doDeleteSession(deleteTasks) {
      this.deleting = true;
      const sessionId = Alpine.store("app").sessionId;
      try {
        await api.deleteSession(sessionId, deleteTasks);
        Alpine.store("app").showToast("Session deleted");
        Alpine.store("app").navigate("sessions");
      } catch (e) {
        console.error("Delete failed:", e);
        Alpine.store("app").showToast("Delete failed: " + sanitizeError(e.message), "error");
      }
      this.deleting = false;
      this.deleteConfirm = false;
    },

    openTaskPanel(taskListId) {
      const tl = this.detail?.task_lists?.find((t) => t.task_list_id === taskListId);
      if (tl && tl.tasks.length > 0) {
        Alpine.store("app").openTaskPanel(taskListId, tl.tasks[0].id, tl.tasks);
      }
    },

    get totalTasks() {
      if (!this.detail?.task_lists) return 0;
      return this.detail.task_lists.reduce((sum, tl) => sum + tl.tasks.length, 0);
    },
  }));

  // Task panel (slide-over)
  Alpine.data("taskPanel", () => ({
    deleteConfirm: false,
    deleting: false,

    get panel() { return Alpine.store("app").taskPanel; },
    get currentTask() {
      if (!this.panel) return null;
      return this.panel.tasks.find((t) => t.id === this.panel.taskId) || this.panel.tasks[0];
    },
    get siblingTasks() {
      return this.panel?.tasks || [];
    },
    get isOrphan() {
      return this.panel?.isOrphan || false;
    },

    selectTask(taskId) {
      if (this.panel) {
        Alpine.store("app").taskPanel = { ...this.panel, taskId };
      }
      this.deleteConfirm = false;
    },

    close() {
      Alpine.store("app").closeTaskPanel();
      this.deleteConfirm = false;
    },

    async goToSession() {
      if (this.panel) {
        const taskListId = this.panel.taskListId;
        Alpine.store("app").closeTaskPanel();
        Alpine.store("app").navigate("session/" + taskListId);
      }
    },

    async doDeleteTask() {
      if (!this.panel || !this.currentTask) return;
      this.deleting = true;
      try {
        const result = await api.deleteTask(this.panel.taskListId, this.currentTask.id);
        const remaining = this.panel.tasks.filter((t) => t.id !== this.currentTask.id);
        if (remaining.length === 0) {
          Alpine.store("app").closeTaskPanel();
          if (result.task_list_now_empty) {
            Alpine.store("app").showToast("Task and empty task list deleted");
          } else {
            Alpine.store("app").showToast("Task deleted");
          }
        } else {
          Alpine.store("app").taskPanel = {
            ...this.panel,
            taskId: remaining[0].id,
            tasks: remaining,
          };
          Alpine.store("app").showToast("Task deleted");
        }
      } catch (e) {
        console.error("Delete task failed:", e);
        Alpine.store("app").showToast("Delete failed: " + sanitizeError(e.message), "error");
      }
      this.deleting = false;
      this.deleteConfirm = false;
    },

    async doDeleteTaskAndList() {
      if (!this.panel) return;
      this.deleting = true;
      try {
        await api.deleteTaskList(this.panel.taskListId);
        Alpine.store("app").closeTaskPanel();
        Alpine.store("app").showToast("Task list deleted");
      } catch (e) {
        console.error("Delete task list failed:", e);
        Alpine.store("app").showToast("Delete failed: " + sanitizeError(e.message), "error");
      }
      this.deleting = false;
      this.deleteConfirm = false;
    },
  }));
});

document.addEventListener("alpine:init", () => {
  Alpine.data("chartsComponent", () => ({
    async init() {
      await Alpine.store("charts").fetchAll();
      this.$watch("$store.charts.dailyTokens", () => this.renderTokenChart());
      this.$watch("$store.charts.modelDistribution", () => this.renderModelChart());
      this.$watch("$store.charts.activityHeatmap", () => this.renderHeatmap());
      // Re-render on theme change
      const observer = new MutationObserver(() => {
        Alpine.store("charts").destroyCharts();
        this.renderTokenChart();
        this.renderModelChart();
        this.renderHeatmap();
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    },

    renderTokenChart() {
      const data = Alpine.store("charts").dailyTokens;
      if (!data || !data.labels.length) return;
      const canvas = this.$refs.tokenChart;
      if (!canvas) return;

      Alpine.store("charts").destroyCharts();

      const textTertiary = getCSSVar("--text-tertiary");
      const surface3 = getCSSVar("--surface-3");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

      Alpine.store("charts")._chartInstances.token = new Chart(canvas, {
        type: "bar",
        data: {
          labels: data.labels.map((d) => {
            const parts = d.split("-");
            return parts[2] + (parts[2] === "01" ? " " + months[parseInt(parts[1], 10) - 1] : "");
          }),
          datasets: [
            { label: "Output",       data: data.datasets.output,       backgroundColor: getCSSVar("--chart-1") },
            { label: "Input",        data: data.datasets.input,        backgroundColor: getCSSVar("--chart-2") },
            { label: "Cache Read",   data: data.datasets.cache_read,   backgroundColor: getCSSVar("--chart-3") },
            { label: "Cache Create", data: data.datasets.cache_create, backgroundColor: getCSSVar("--chart-4") },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          scales: {
            x: {
              stacked: true,
              grid: { display: false },
              ticks: { font: { family: getCSSVar("--font-mono"), size: 10 }, color: textTertiary, maxRotation: 0 },
            },
            y: {
              stacked: true,
              grid: { color: surface3 },
              ticks: { font: { family: getCSSVar("--font-mono"), size: 10 }, color: textTertiary, callback: (v) => formatTokenCount(v) },
            },
          },
          plugins: {
            legend: { display: true, position: "bottom", labels: {
              color: getCSSVar("--text-secondary"),
              font: { family: getCSSVar("--font-sans"), size: 11 },
              boxWidth: 10, boxHeight: 10, padding: 16, usePointStyle: true, pointStyle: "rectRounded",
            }},
            tooltip: {
              backgroundColor: getCSSVar("--surface-3"),
              titleColor: getCSSVar("--text-primary"),
              bodyColor: getCSSVar("--text-primary"),
              bodyFont: { family: getCSSVar("--font-mono") },
              cornerRadius: 2,
              displayColors: true,
              callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${formatTokenCount(ctx.raw)}` },
            },
          },
        },
      });
    },

    renderModelChart() {
      const data = Alpine.store("charts").modelDistribution;
      if (!data || !data.length) return;
      const canvas = this.$refs.modelChart;
      if (!canvas) return;

      if (Alpine.store("charts")._chartInstances.model) {
        Alpine.store("charts")._chartInstances.model.destroy();
      }

      const surface0 = getCSSVar("--surface-0");
      const chartColors = [1, 2, 3, 4, 5, 6].map((n) => getCSSVar("--chart-" + n));
      const colors = data.map((_, i) => chartColors[i % chartColors.length]);

      const totalTokens = data.reduce((s, d) => s + d.tokens, 0);

      Alpine.store("charts")._chartInstances.model = new Chart(canvas, {
        type: "doughnut",
        data: {
          labels: data.map((d) => d.model),
          datasets: [{ data: data.map((d) => d.tokens), backgroundColor: colors, borderColor: surface0, borderWidth: 2 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          cutout: "60%",
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: getCSSVar("--surface-3"),
              titleColor: getCSSVar("--text-primary"),
              bodyColor: getCSSVar("--text-primary"),
              bodyFont: { family: getCSSVar("--font-mono") },
              cornerRadius: 2,
              callbacks: {
                label: (ctx) => {
                  const pct = totalTokens > 0 ? ((ctx.raw / totalTokens) * 100).toFixed(1) : "0";
                  return ` ${ctx.label}: ${formatTokenCount(ctx.raw)} (${pct}%)`;
                },
              },
            },
          },
        },
      });

      // Render legend
      const legendEl = this.$refs.modelLegend;
      if (legendEl) {
        legendEl.innerHTML = data.map((d, i) => {
          const pct = totalTokens > 0 ? ((d.tokens / totalTokens) * 100).toFixed(0) : "0";
          return `<div class="chart-legend-item">
            <span class="chart-legend-swatch" style="background:${colors[i]}"></span>
            <span class="chart-legend-label">${d.model}</span>
            <span class="chart-legend-value">${pct}%</span>
          </div>`;
        }).join("");
      }
    },

    renderHeatmap() {
      const data = Alpine.store("charts").activityHeatmap;
      if (!data) return;
      const canvas = this.$refs.heatmapCanvas;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;

      const labelW = 32;
      const labelH = 16;
      const gap = 2;
      const availW = canvas.clientWidth - labelW;
      const cellW = Math.floor((availW - gap * 23) / 24);
      const cellH = Math.floor(cellW / 1.6);

      canvas.width = (labelW + cellW * 24 + gap * 23) * dpr;
      canvas.height = (labelH + cellH * 7 + gap * 6) * dpr;
      canvas.style.height = (labelH + cellH * 7 + gap * 6) + "px";
      ctx.scale(dpr, dpr);

      const heatRamp = [0, 1, 2, 3, 4].map((n) => getCSSVar("--heatmap-" + n));
      const textSecondary = getCSSVar("--text-secondary");

      function intensityColor(value, max) {
        if (value === 0) return heatRamp[0];
        const pct = max > 0 ? value / max : 0;
        if (pct <= 0.25) return heatRamp[1];
        if (pct <= 0.50) return heatRamp[2];
        if (pct <= 0.75) return heatRamp[3];
        return heatRamp[4];
      }

      // Hour labels (top) — every 3 hours
      ctx.font = `10px ${getCSSVar("--font-sans")}`;
      ctx.fillStyle = textSecondary;
      ctx.textAlign = "center";
      for (let h = 0; h < 24; h += 3) {
        const x = labelW + h * (cellW + gap) + cellW / 2;
        ctx.fillText(String(h).padStart(2, "0"), x, 10);
      }

      // Grid
      for (let day = 0; day < 7; day++) {
        // Day label
        ctx.font = `10px ${getCSSVar("--font-sans")}`;
        ctx.fillStyle = textSecondary;
        ctx.textAlign = "right";
        ctx.fillText(data.dayLabels[day], labelW - 6, labelH + day * (cellH + gap) + cellH / 2 + 3);

        for (let hour = 0; hour < 24; hour++) {
          const x = labelW + hour * (cellW + gap);
          const y = labelH + day * (cellH + gap);
          const value = data.grid[day][hour];

          ctx.fillStyle = intensityColor(value, data.maxValue);
          ctx.beginPath();
          ctx.roundRect(x, y, cellW, cellH, 2);
          ctx.fill();
        }
      }
    },
  }));
});

// Keyboard shortcut: Cmd+K focuses search
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    Alpine.store("app").navigate("search");
    requestAnimationFrame(() => {
      const input = document.querySelector('[x-ref="searchInput"]');
      if (input) input.focus();
    });
  }
});
