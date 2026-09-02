/**
 * The single way the frontend talks to the API. No component calls fetch
 * directly, so auth, error shape and the 401 path are handled in one place.
 *
 * The token is held in memory only. It is deliberately not in
 * localStorage: any XSS on the page could read it there, and this app has
 * no cross-tab requirement that would justify the risk.
 */
export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.status = status; this.code = code; this.details = details; this.requestId = requestId;
  }
  get isAuth() { return this.status === 401; }
  get isValidation() { return this.status === 422; }
}

/** A key for one user action, stable across retries of that same action. */
export const newActionKey = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

export function createClient({ baseUrl = '/api', onUnauthenticated } = {}) {
  let token = null;
  let employee = null;

  async function request(path, { method = 'GET', body, isForm, idempotencyKey } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    // Sent once per user action. If the response is lost and the request is
    // retried, the server returns the original result instead of acting twice.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let payload;
    if (isForm) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
    } catch {
      // Network failure is a first-class state, not an unhandled rejection.
      throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection.');
    }

    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!res.ok) {
      if (res.status === 401) {
        token = null; employee = null;
        try { localStorage?.clear?.(); sessionStorage?.clear?.(); } catch { /* best effort */ }
        onUnauthenticated?.(data?.error);
      }
      throw new ApiError(res.status, data?.error || 'error',
        data?.message || 'Something went wrong.', data?.details, data?.requestId);
    }
    return data;
  }

  return {
    get session() { return employee; },
    get isAuthenticated() { return !!token; },

    async login(email, password) {
      const out = await request('/auth/login', { method: 'POST', body: { email, password } });
      token = out.token; employee = out.employee;
      return employee;
    },
    async logout() {
      try {
        await request('/auth/logout', { method: 'POST' });
      } finally {
        token = null;
        employee = null;
        // On a shared phone the next person must not find anything of the
        // last one. API responses were never cached; this clears the shell
        // cache and any storage a future change might introduce.
        try {
          if (typeof caches !== 'undefined') {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
          localStorage?.clear?.();
          sessionStorage?.clear?.();
        } catch { /* clearing is best effort; the session is already gone */ }
      }
    },
    me: () => request('/me'),

    sites: () => request('/attendance/sites'),
    checkIn: (fix, key) => request('/attendance/check-in', { method: 'POST', body: fix, idempotencyKey: key }),
    checkOut: (fix, key) => request('/attendance/check-out', { method: 'POST', body: fix, idempotencyKey: key }),
    reportIncident: (body, key) => request('/attendance/incidents', { method: 'POST', body, idempotencyKey: key }),
    myIncidents: () => request('/attendance/incidents/me'),
    myAttendance: (month) => request(`/attendance/me${month ? `?month=${month}` : ''}`),

    myTasks: (view) => request(`/tasks/me${view ? `?view=${view}` : ''}`),
    task: (id) => request(`/tasks/${id}`),
    startTask: (id) => request(`/tasks/${id}/start`, { method: 'POST' }),
    submitTask: (id, body, key) => request(`/tasks/${id}/submit`, { method: 'POST', body, idempotencyKey: key }),

    myClaims: (month) => request(`/claims/me${month ? `?month=${month}` : ''}`),
    createClaim: (body, key) => request('/claims', { method: 'POST', body, idempotencyKey: key }),

    async uploadFile(file) {
      const form = new FormData();
      form.append('file', file);
      return request('/files', { method: 'POST', body: form, isForm: true });
    },
    fileLink: (id) => request(`/files/${id}/link`),

    notifications: () => request('/notifications'),

    broadcasts: () => request('/broadcasts'),
    markBroadcastRead: (id) => request(`/broadcasts/${id}/read`, { method: 'POST' }),

    latToday: () => request('/lat/today'),
    latStart: () => request('/lat/attempts', { method: 'POST' }),
    latSubmit: (attemptId, answers) => request(`/lat/attempts/${attemptId}/submit`, { method: 'POST', body: { answers } }),
    latHistory: () => request('/lat/me'),

    admin: {
      dashboard: () => request('/admin/dashboard'),
      employees: () => request('/admin/employees'),
      createEmployee: (body) => request('/admin/employees', { method: 'POST', body }),
      createTask: (body) => request('/tasks', { method: 'POST', body }),
      claims: (status) => request(`/admin/claims${status ? `?status=${status}` : ''}`),
      decideClaim: (id, body, key) => request(`/admin/claims/${id}/decide`, { method: 'POST', body, idempotencyKey: key }),
      incidents: (state) => request(`/admin/incidents${state ? `?state=${state}` : ''}`),
      resolveIncident: (id, body, key) => request(`/admin/incidents/${id}/resolve`, { method: 'POST', body, idempotencyKey: key }),
      approve: (id, key) => request(`/admin/submissions/${id}/approve`, { method: 'POST', idempotencyKey: key }),
      returnWork: (id, reason, key) => request(`/admin/submissions/${id}/return`, { method: 'POST', body: { reason }, idempotencyKey: key }),
      audit: () => request('/admin/audit'),
      broadcasts: () => request('/admin/broadcasts'),
      publishBroadcast: (body, key) => request('/admin/broadcasts', { method: 'POST', body, idempotencyKey: key }),
      publishWords: (words, date) => request('/admin/lat/sets', { method: 'POST', body: { words, ...(date ? { date } : {}) } }),
      latResults: (date) => request(`/admin/lat/results${date ? `?date=${date}` : ''}`),
    },
  };
}

/**
 * Reads the device location once and shapes it for the API. The browser
 * only reports the fix; whether it is acceptable is the server's decision.
 */
export function readFix({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new ApiError(0, 'no_geolocation', 'This device cannot report its location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        latitude: p.coords.latitude, longitude: p.coords.longitude,
        accuracy: Math.round(p.coords.accuracy),
        device: { platform: navigator.platform, ua: navigator.userAgent.slice(0, 120) },
      }),
      (e) => reject(new ApiError(0, 'location_denied',
        e.code === 1 ? 'Location permission is needed to check in.' : 'Could not read your location.')),
      { enableHighAccuracy: true, timeout, maximumAge: 0 }
    );
  });
}
