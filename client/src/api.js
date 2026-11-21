const TOKEN_KEY = 'frontdesk.token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, data) { super(data?.error || `Request failed (${status})`); this.status = status; this.data = data; }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && getToken()) headers.Authorization = `Bearer ${getToken()}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) { setToken(null); window.dispatchEvent(new Event('frontdesk:signout')); }
    throw new ApiError(res.status, data);
  }
  return data;
}

const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtTime = (iso) => (iso ? fmt.format(new Date(iso)) + ' IST' : '-');
