const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api";

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = localStorage.getItem("sentinel-token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!(options.body instanceof FormData) && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

  if (response.status === 401) {
    localStorage.removeItem("sentinel-token");
    localStorage.removeItem("sentinel-user");
  }
  if (!response.ok) {
    const error = new Error(
      data.message || data.error || `Request failed (${response.status})`
    );
    error.status = response.status;
    error.code = data.code;
    error.details = data.match || data.details || null;
    throw error;
  }
  return data;
}

export const login = (username, password) =>
  request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });

export const getDocuments = () => request("/documents");
export const getDocument = id => request(`/documents/${encodeURIComponent(id)}`);
export const verifyDocument = id =>
  request(`/documents/${encodeURIComponent(id)}/verify`, { method: "POST" });
export const getDocumentHistory = id =>
  request(`/documents/${encodeURIComponent(id)}/history`);

export const uploadDocument = (file, uploaderId) => {
  const form = new FormData();
  form.append("file", file);
  form.append("uploaderId", uploaderId);
  return request("/documents/upload", { method: "POST", body: form });
};

export const addDocumentVersion = (id, file, reason, updatedBy) => {
  const form = new FormData();
  form.append("newFile", file);
  form.append("reason", reason);
  form.append("updatedBy", updatedBy);
  return request(`/documents/${encodeURIComponent(id)}/version`, {
    method: "POST", body: form
  });
};

export function logout() {
  localStorage.removeItem("sentinel-token");
  localStorage.removeItem("sentinel-user");
}


export const simulateTampering = id =>
  request(`/documents/${encodeURIComponent(id)}/demo-tamper`, { method: "POST" });

export const restoreOriginal = id =>
  request(`/documents/${encodeURIComponent(id)}/demo-restore`, { method: "POST" });

export const getUsers = () => request("/users");

export const requestCorrection = id =>
  request(`/documents/${encodeURIComponent(id)}/request-correction`, { method: "POST" });

export const approveCorrection = id =>
  request(`/documents/${encodeURIComponent(id)}/approve-correction`, { method: "POST" });

export const denyCorrection = id =>
  request(`/documents/${encodeURIComponent(id)}/deny-correction`, { method: "POST" });

export const uploadCorrectedVersion = (id, file, reason) => {
  const form = new FormData();
  form.append("file", file);
  form.append("reason", reason);
  return request(`/documents/${encodeURIComponent(id)}/version`, { method: "POST", body: form });
};
