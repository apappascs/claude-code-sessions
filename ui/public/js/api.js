// ui/public/js/api.js
const BASE = "/api";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export const api = {
  // Dashboard
  dashboardStats: () => get("/dashboard/stats"),
  recentSessions: (limit = 5) => get(`/sessions?limit=${limit}&sort=recency`),

  // Sessions
  listSessions: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return get(`/sessions${q ? "?" + q : ""}`);
  },
  sessionStats: (sessionPath) =>
    get(`/sessions/stats?path=${encodeURIComponent(sessionPath)}`),

  // Search
  search: (query, params = {}) => {
    const q = new URLSearchParams({ query, ...params }).toString();
    return get(`/search?${q}`);
  },

  // Tasks
  taskLists: () => get("/tasks/lists"),
  tasks: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return get(`/tasks${q ? "?" + q : ""}`);
  },
};
