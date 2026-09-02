import React, { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react';
import { createClient, ApiError, readFix, newActionKey } from './api-client.js';
import { LatCard, LatScreen, AdminLat } from './Lat.jsx';
import { BroadcastCard, BroadcastList, AdminBroadcasts } from './Broadcast.jsx';

/* ═══════════════════════════════════════════════════════════════ tokens */

const LIGHT = {
  name: 'light', bg: '#FFFFFF', sub: '#FAFAFA', line: '#EAEAEA', hair: '#F2F2F2',
  text: '#0A0A0A', mute: '#71717A', faint: '#A1A1AA', accent: '#D9451F', overlay: 'rgba(10,10,10,.28)',
};
const DARK = {
  name: 'dark', bg: '#0A0A0A', sub: '#131313', line: '#262626', hair: '#1C1C1C',
  text: '#FAFAFA', mute: '#A1A1AA', faint: '#71717A', accent: '#FF6A3D', overlay: 'rgba(0,0,0,.6)',
};

/* Status is carried by a glyph plus a word. Colour appears only where
   something needs a person to act, which is also the accessible default. */
const STATE = {
  'Not Started': { glyph: 'empty' }, 'In Progress': { glyph: 'half' },
  Submitted: { glyph: 'ring' }, Completed: { glyph: 'full' },
  Returned: { glyph: 'alert', alert: true }, Overdue: { glyph: 'alert', alert: true },
  Present: { glyph: 'full' }, 'Field Work': { glyph: 'ring' }, Late: { glyph: 'half' },
  Leave: { glyph: 'empty' }, Absent: { glyph: 'alert', alert: true },
  'Not checked in': { glyph: 'empty' }, Pending: { glyph: 'ring' },
  Approved: { glyph: 'full' }, Rejected: { glyph: 'alert', alert: true },
};

const T_CTX = createContext(LIGHT);
const useT = () => useContext(T_CTX);
const API = createContext(null);
const useApi = () => useContext(API);

/* ═══════════════════════════════════════════════════════════════ helpers */

const pad = (n) => String(n).padStart(2, '0');
const rupees = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;

/** The API returns timestamptz; the office reads it in IST. */
function istTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}
function istDateLong(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long',
  });
}
function istDateShort(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
}
function to12(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
function duration(a, b) {
  if (!a || !b) return '—';
  const mins = Math.round((new Date(b) - new Date(a)) / 60000);
  return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;
}
const greeting = () => {
  const h = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/** True below the tablet breakpoint. Drives layout, not just styling. */
function useIsPhone(breakpoint = 768) {
  const [phone, setPhone] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${breakpoint - 1}px)`);
    const on = (e) => setPhone(e.matches);
    setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [breakpoint]);
  return phone;
}

/**
 * Every remote read goes through this: loading and error are states the
 * UI must render, not conditions to hope away.
 */
function useResource(loader, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const alive = useRef(true);
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loader();
      if (alive.current) setState({ loading: false, error: null, data });
    } catch (e) {
      if (alive.current) setState({ loading: false, error: e, data: null });
    }
  }, deps);
  useEffect(() => { alive.current = true; reload(); return () => { alive.current = false; }; }, [reload]);
  return { ...state, reload };
}

/* ═══════════════════════════════════════════════════════════ primitives */

function Glyph({ state, size = 11 }) {
  const T = useT();
  const s = STATE[state] || STATE['Not Started'];
  const c = size / 2, r = c - 1;
  const stroke = s.alert ? T.accent : s.glyph === 'empty' ? T.faint : T.text;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', flexShrink: 0 }}>
      {s.glyph === 'empty' && <circle cx={c} cy={c} r={r} fill="none" stroke={stroke} strokeWidth="1.4" />}
      {s.glyph === 'half' && (<>
        <circle cx={c} cy={c} r={r} fill="none" stroke={stroke} strokeWidth="1.4" />
        <path d={`M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} Z`} fill={stroke} />
      </>)}
      {s.glyph === 'ring' && (<>
        <circle cx={c} cy={c} r={r} fill="none" stroke={stroke} strokeWidth="1.4" />
        <circle cx={c} cy={c} r={r * 0.42} fill={stroke} />
      </>)}
      {s.glyph === 'full' && <circle cx={c} cy={c} r={r} fill={stroke} />}
      {s.glyph === 'alert' && <circle cx={c} cy={c} r={r} fill={T.accent} />}
    </svg>
  );
}
function Status({ state }) {
  const T = useT();
  const alert = (STATE[state] || {}).alert;
  return (
    <span className="pop" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: alert ? T.accent : T.mute, whiteSpace: 'nowrap' }}>
      <Glyph state={state} />{state}
    </span>
  );
}
function Btn({ children, onClick, variant = 'solid', disabled, busy, full, type = 'button' }) {
  const T = useT();
  const looks = {
    solid: { background: disabled || busy ? T.hair : T.text, color: disabled || busy ? T.faint : T.bg, border: 'none' },
    accent: { background: disabled || busy ? T.hair : T.accent, color: disabled || busy ? T.faint : '#fff', border: 'none' },
    line: { background: 'transparent', color: T.text, border: `1px solid ${T.line}` },
  };
  return (
    <button type={type} onClick={disabled || busy ? undefined : onClick} disabled={disabled || busy}
      className="press" style={{
        ...looks[variant], padding: '10px 16px', borderRadius: 8, fontSize: 14, fontWeight: 500,
        width: full ? '100%' : undefined, cursor: disabled || busy ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
      {busy && <Spinner />}{children}
    </button>
  );
}
const Spinner = () => <span className="spin" style={{ width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} />;

function Eyebrow({ children, right }) {
  const T = useT();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
      <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em', color: T.faint }}>{children}</div>
      {right}
    </div>
  );
}
const M = ({ children, style }) => <span className="mono" style={style}>{children}</span>;

function Skel({ h = 14, w = '100%' }) {
  const T = useT();
  return <div className="pulse" style={{ height: h, width: w, borderRadius: 6, background: T.hair }} />;
}
function Rows({ n = 3 }) {
  return <div style={{ display: 'grid', gap: 14 }}>{Array.from({ length: n }, (_, i) => <Skel key={i} h={38} />)}</div>;
}

/** A failed load is recoverable, so it always offers the retry. */
function ErrorBlock({ error, onRetry }) {
  const T = useT();
  return (
    <div style={{ padding: '24px 0' }}>
      <div style={{ fontSize: 14, color: T.accent, marginBottom: 6 }}>{error?.message || 'Something went wrong.'}</div>
      {error?.requestId && <M style={{ fontSize: 11, color: T.faint }}>ref {error.requestId.slice(0, 8)}</M>}
      {onRetry && <div style={{ marginTop: 14 }}><Btn variant="line" onClick={onRetry}>Try again</Btn></div>}
    </div>
  );
}
function Blank({ title, hint }) {
  const T = useT();
  return (
    <div style={{ padding: '56px 0', textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, marginTop: 6, color: T.mute }}>{hint}</div>}
    </div>
  );
}
function Field({ label, children, error }) {
  const T = useT();
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: T.faint, marginBottom: 8 }}>{label}</div>
      {children}
      {error && <div style={{ fontSize: 12, marginTop: 8, color: T.accent }}>{error}</div>}
    </div>
  );
}
function Input(props) {
  const T = useT();
  return <input {...props} style={{
    width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 14,
    background: 'transparent', border: `1px solid ${T.line}`, color: T.text, outline: 'none', ...props.style,
  }} />;
}

/* ═════════════════════════════════════════════════════════════════ root */

export default function App() {
  const [theme, setTheme] = useState('light');
  const T = theme === 'light' ? LIGHT : DARK;
  const [session, setSession] = useState(null);
  const [expired, setExpired] = useState(false);

  // One client for the app's lifetime. A 401 from any call drops the
  // session, so an expired token cannot leave the UI in a signed-in state.
  const client = useRef(null);
  if (!client.current) {
    client.current = createClient({
      baseUrl: import.meta?.env?.VITE_API_URL || '/api',
      onUnauthenticated: (code) => {
        setSession(null);
        setExpired(code === 'token_expired' || code === 'token_revoked');
      },
    });
  }
  const api = client.current;

  return (
    <T_CTX.Provider value={T}>
      <API.Provider value={api}>
        <div style={{ minHeight: '100vh', background: T.bg, color: T.text }}>
          <Styles T={T} />
          {!session
            ? <Login onIn={(emp) => { setSession(emp); setExpired(false); }} expired={expired} theme={theme} setTheme={setTheme} />
            : session.isAdmin
              ? <Admin me={session} onOut={() => setSession(null)} theme={theme} setTheme={setTheme} />
              : <Employee me={session} onOut={() => setSession(null)} theme={theme} setTheme={setTheme} />}
        </div>
      </API.Provider>
    </T_CTX.Provider>
  );
}

function Styles({ T }) {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
      *{font-family:Inter,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;box-sizing:border-box}
      html,body{margin:0;overflow-x:hidden;max-width:100%}
      #root{overflow-x:hidden}
      img,svg{max-width:100%}
      .mono{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
      .tight{letter-spacing:-.035em}
      input:focus,textarea:focus,select:focus{border-color:${T.text}!important}
      input::placeholder{color:${T.faint}}
      button{transition:opacity .15s,transform .12s}
      .press:active{transform:scale(.98)}
      .press:hover{opacity:.75}
      .row:hover{background:${T.sub}}
      button:focus-visible,input:focus-visible{outline:1.5px solid ${T.text};outline-offset:2px}
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      @keyframes riseIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
      @keyframes popIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
      @keyframes spinIt{to{transform:rotate(360deg)}}
      @keyframes pulseIt{0%,100%{opacity:1}50%{opacity:.45}}
      .fade{animation:fadeIn .2s ease both}
      .rise{animation:riseIn .28s cubic-bezier(.2,.8,.3,1) both}
      .pop{animation:popIn .22s cubic-bezier(.2,.8,.3,1) both}
      .spin{animation:spinIt .8s linear infinite}
      .pulse{animation:pulseIt 1.4s ease-in-out infinite}
      @media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;transition-duration:.001ms!important}}
    `}</style>
  );
}

/**
 * Shows the company logo if one has been added, and falls back to the
 * name in type if not. A broken image icon on the login screen of an
 * internal tool looks like the app itself is broken.
 */
function Brand({ size = 28, showName = true }) {
  const T = useT();
  const [hasLogo, setHasLogo] = useState(true);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {hasLogo && (
        <img src="/logo.png" alt="" width={size} height={size} onError={() => setHasLogo(false)}
          style={{ objectFit: 'contain', display: 'block' }} />
      )}
      {showName && (
        <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.16em', color: T.text }}>
          Sapience Team
        </span>
      )}
    </div>
  );
}

function ThemeToggle({ theme, setTheme }) {
  const T = useT();
  return (
    <button className="press" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      style={{ background: 'none', border: 'none', color: T.mute, fontSize: 12, cursor: 'pointer', padding: 8 }}
      aria-label="Toggle theme">{theme === 'dark' ? 'Light' : 'Dark'}</button>
  );
}

/* ════════════════════════════════════════════════════════════════ login */

function Login({ onIn, expired, theme, setTheme }) {
  const T = useT();
  const api = useApi();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    if (!email.trim() || !password) { setError({ message: 'Enter your email and password.' }); return; }
    setBusy(true); setError(null);
    try {
      onIn(await api.login(email.trim(), password));
    } catch (err) {
      // The API deliberately gives the same answer for unknown account and
      // wrong password, so the UI must not embellish it.
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '20px 24px' }}>
        <Brand />
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </header>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px 80px' }}>
        <form className="rise" onSubmit={submit} style={{ width: '100%', maxWidth: 330 }}>
          <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 6px' }}>Sapience Team</h1>
          <p style={{ fontSize: 14, color: T.mute, margin: '0 0 40px' }}>Sign in with your work email.</p>

          {expired && (
            <div className="fade" style={{ fontSize: 12, color: T.mute, marginBottom: 20, paddingLeft: 12, borderLeft: `2px solid ${T.line}` }}>
              Your session ended. Sign in again to continue.
            </div>
          )}

          <Field label="Email">
            <Input type="email" value={email} autoComplete="username" autoFocus
              onChange={(e) => { setEmail(e.target.value); setError(null); }} />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} autoComplete="current-password"
              onChange={(e) => { setPassword(e.target.value); setError(null); }} />
          </Field>

          {error && (
            <div className="fade" style={{ fontSize: 13, color: T.accent, marginBottom: 20 }}>
              {error.message}
              {error.status === 429 && <div style={{ fontSize: 12, color: T.mute, marginTop: 4 }}>Wait a few minutes before trying again.</div>}
            </div>
          )}

          <Btn type="submit" variant="solid" full busy={busy} onClick={submit}>
            {busy ? 'Signing in' : 'Sign in'}
          </Btn>
        </form>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════ employee app */

function Employee({ me, onOut, theme, setTheme }) {
  const T = useT();
  const api = useApi();
  const [tab, setTab] = useState('home');
  const [openTask, setOpenTask] = useState(null);
  const [latOpen, setLatOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);
  const profile = useResource(() => api.me(), []);
  const lat = useResource(() => api.latToday(), []);
  const broadcasts = useResource(() => api.broadcasts(), []);

  const nav = [
    ['home', 'Home'], ['tasks', 'Tasks'], ['attendance', 'Attendance'],
    ...(profile.data?.claims_enabled ? [['claims', 'Claims']] : []),
    ['profile', 'Profile'],
  ];

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 420, minHeight: '100vh', borderLeft: `1px solid ${T.line}`, borderRight: `1px solid ${T.line}`, paddingBottom: 84, position: 'relative' }}>
        <div key={newsOpen ? 'news' : latOpen ? 'lat' : openTask || tab} className="rise">
          {newsOpen ? <BroadcastList T={T} api={api} broadcasts={broadcasts} onBack={() => setNewsOpen(false)} />
            : latOpen ? <LatScreen T={T} api={api} lat={lat} onBack={() => { setLatOpen(false); lat.reload(); }} />
            : openTask ? <TaskDetail id={openTask} onBack={() => setOpenTask(null)} />
            : tab === 'home' ? <EHome me={me} profile={profile} onOpenTask={setOpenTask} lat={lat}
                onOpenLat={() => setLatOpen(true)} broadcasts={broadcasts} onOpenNews={() => setNewsOpen(true)} />
              : tab === 'tasks' ? <ETasks onOpenTask={setOpenTask} />
                : tab === 'attendance' ? <EAttendance profile={profile} />
                  : tab === 'claims' ? <EClaims profile={profile} />
                    : <EProfile profile={profile} onOut={onOut} theme={theme} setTheme={setTheme} onOpenNews={() => setNewsOpen(true)} />}
        </div>

        <nav style={{
          position: 'fixed', bottom: 0, width: '100%', maxWidth: 420, display: 'flex',
          background: T.bg, borderTop: `1px solid ${T.line}`,
        }}>
          {nav.map(([k, label]) => {
            const on = tab === k && !openTask && !latOpen && !newsOpen;
            return (
              <button key={k} className="press" onClick={() => { setOpenTask(null); setLatOpen(false); setNewsOpen(false); setTab(k); }}
                style={{
                  flex: 1, padding: '14px 0', background: 'none', border: 'none', cursor: 'pointer',
                  color: on ? T.text : T.faint, fontSize: 12, position: 'relative',
                }}>
                {on && <span style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 18, height: 1.5, background: T.accent }} />}
                {label}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

function EHome({ me, profile, onOpenTask, lat, onOpenLat, broadcasts, onOpenNews }) {
  const T = useT();
  const api = useApi();
  const attendance = useResource(() => api.myAttendance(), []);
  const tasks = useResource(() => api.myTasks('today'), []);
  const today = attendance.data?.[0];
  const isToday = today && new Date(today.work_date).toISOString().slice(0, 10) ===
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const att = isToday ? today : null;

  const done = (tasks.data || []).filter((t) => t.effective_status === 'Completed').length;

  return (
    <div style={{ padding: '32px 24px 0' }}>
      <div style={{ marginBottom: 40 }}>
        <div style={{ fontSize: 14, color: T.mute }}>{greeting()}, {me.name.split(' ')[0]}</div>
        <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 4 }}>
          {istDateLong(new Date())}
        </M>
      </div>

      <BroadcastCard T={T} broadcasts={broadcasts} onOpen={onOpenNews} />

      <CheckInBlock att={att} loading={attendance.loading} error={attendance.error}
        site={profile.data} onDone={attendance.reload} onRetry={attendance.reload} />

      <LatCard T={T} lat={lat} onOpen={onOpenLat} />

      <div style={{ marginBottom: 40 }}>
        <Eyebrow right={tasks.data?.length ? <M style={{ fontSize: 11, color: T.faint }}>{done}/{tasks.data.length} done</M> : null}>Today</Eyebrow>
        {tasks.loading ? <Rows />
          : tasks.error ? <ErrorBlock error={tasks.error} onRetry={tasks.reload} />
            : !tasks.data.length ? <Blank title="Nothing assigned for today" hint="New tasks appear here." />
              : <div style={{ borderTop: `1px solid ${T.line}` }}>
                {tasks.data.map((t) => <TaskRow key={t.task_id} task={t} onOpen={() => onOpenTask(t.task_id)} />)}
              </div>}
      </div>
    </div>
  );
}

/**
 * The client reads the device fix and posts it. Whether the fix is close
 * enough, accurate enough or genuine is decided by the API, so every
 * refusal here is a server message rendered verbatim.
 */
function CheckInBlock({ att, loading, error, site, onDone, onRetry }) {
  const T = useT();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(null);
  const [problem, setProblem] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  // Held across retries of the same tap, so a lost response cannot become
  // a second check-in when the employee presses again.
  const actionKey = useRef(null);

  /** Maps a failure to the reason recorded on an incident report. */
  const reasonFor = (e) => ({
    outside_radius: 'outside_radius', poor_accuracy: 'poor_accuracy',
    mock_location: 'mock_location', location_denied: 'permission_denied',
    no_geolocation: 'gps_unavailable', network_error: 'network_unavailable',
  }[e?.code] || (e?.status >= 500 ? 'server_unavailable' : 'other'));

  const act = async (mode) => {
    setBusy(true); setProblem(null); setReported(false);
    if (!actionKey.current) actionKey.current = newActionKey();
    try {
      setStage('Checking your location…');
      const fix = await readFix();
      setStage('Confirming with the server…');
      // Nothing is shown as done until the server has actually confirmed it.
      await (mode === 'in' ? api.checkIn(fix, actionKey.current) : api.checkOut(fix, actionKey.current));
      actionKey.current = null;
      await onDone();
    } catch (e) {
      setProblem({ ...e, message: e.message, code: e.code, status: e.status, mode });
    } finally {
      setBusy(false); setStage(null);
    }
  };

  const report = async () => {
    setReporting(true);
    try {
      await api.reportIncident({
        kind: problem.mode === 'in' ? 'check_in' : 'check_out',
        reason: reasonFor(problem),
        note: problem.message?.slice(0, 900),
      }, newActionKey());
      setReported(true);
    } catch (e) {
      // Already reported today is a success from the employee's point of view.
      setReported(e.code === 'incident_exists');
      if (e.code !== 'incident_exists') setProblem({ ...problem, message: e.message });
    } finally {
      setReporting(false);
    }
  };

  if (loading) return <div style={{ marginBottom: 40 }}><Eyebrow>Attendance</Eyebrow><Skel h={44} w="60%" /></div>;
  if (error) return <div style={{ marginBottom: 40 }}><Eyebrow>Attendance</Eyebrow><ErrorBlock error={error} onRetry={onRetry} /></div>;

  return (
    <div style={{ marginBottom: 40 }}>
      <Eyebrow right={att ? <Status state={att.status} /> : null}>Attendance</Eyebrow>

      {!att && (<>
        <div className="tight" style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Not checked in</div>
        <div style={{ fontSize: 12, color: T.mute, marginBottom: 24 }}>{site?.site_name || ''}</div>
        <Btn variant="accent" full busy={busy} onClick={() => act('in')}>
          {busy ? 'Reading location' : 'Check in'}
        </Btn>
      </>)}

      {att && !att.check_out_time && (<>
        <div className="tight" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1, marginBottom: 6 }}>{istTime(att.check_in_time)}</div>
        <M style={{ fontSize: 11, color: T.faint, display: 'block', marginBottom: 24 }}>
          {att.site_name}{att.check_in_accuracy ? `, ±${att.check_in_accuracy} m` : ''}
        </M>
        <Btn variant="line" full busy={busy} onClick={() => act('out')}>
          {busy ? 'Reading location' : 'Check out'}
        </Btn>
      </>)}

      {att?.check_out_time && (<>
        <div className="tight" style={{ fontSize: 22, fontWeight: 600 }}>
          {istTime(att.check_in_time)} – {istTime(att.check_out_time)}
        </div>
        <div style={{ fontSize: 12, color: T.mute, marginTop: 4 }}>Total {duration(att.check_in_time, att.check_out_time)}</div>
      </>)}

      {busy && stage && (
        <div className="fade" style={{ fontSize: 12, color: T.mute, marginTop: 14 }}>{stage}</div>
      )}

      {problem && !reported && (
        <div className="fade" style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, color: T.accent, lineHeight: 1.5 }}>{problem.message}</div>
          {problem.requestId && (
            <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 6 }}>
              ref {problem.requestId.slice(0, 8)}
            </M>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <Btn variant="line" onClick={() => act(problem.mode)} busy={busy}>Try again</Btn>
            {/* Only after a retry has failed, so this is not the easy path. */}
            <Btn variant="line" onClick={report} busy={reporting}>Report the problem</Btn>
          </div>
        </div>
      )}

      {reported && (
        <div className="pop" style={{ fontSize: 13, color: T.mute, marginTop: 16, lineHeight: 1.5 }}>
          Reported. Your admin has been told, and will sort it out.
          Your attendance for today is still not recorded.
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, onOpen }) {
  const T = useT();
  const st = task.effective_status || task.status;
  return (
    <button className="row press" onClick={onOpen} style={{
      width: '100%', display: 'flex', gap: 14, alignItems: 'flex-start', textAlign: 'left',
      padding: '16px 0', background: 'none', border: 'none', borderBottom: `1px solid ${T.line}`,
      cursor: 'pointer', color: T.text,
    }}>
      <div style={{ paddingTop: 4 }}><Glyph state={st} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.4 }}>{task.title}</div>
        <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
          <M style={{ fontSize: 11, color: st === 'Overdue' ? T.accent : T.faint }}>{to12(task.due_time)}</M>
          <span style={{ fontSize: 11, color: T.faint }}>{task.priority}</span>
          <M style={{ fontSize: 11, color: T.faint }}>{task.task_code}</M>
        </div>
      </div>
    </button>
  );
}

function ETasks({ onOpenTask }) {
  const T = useT();
  const api = useApi();
  const [view, setView] = useState('today');
  const tasks = useResource(() => api.myTasks(view), [view]);
  const views = [['today', 'Today'], ['upcoming', 'Upcoming'], ['completed', 'Done'], ['overdue', 'Overdue']];

  return (
    <div style={{ padding: '32px 24px 0' }}>
      <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: '0 0 24px' }}>Tasks</h1>
      <div style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${T.line}`, marginBottom: 8, overflowX: 'auto' }}>
        {views.map(([k, label]) => (
          <button key={k} className="press" onClick={() => setView(k)} style={{
            background: 'none', border: 'none', padding: '0 0 12px', cursor: 'pointer',
            fontSize: 12, color: view === k ? T.text : T.faint, fontWeight: view === k ? 500 : 400,
            borderBottom: view === k ? `1.5px solid ${T.accent}` : '1.5px solid transparent',
          }}>{label}</button>
        ))}
      </div>
      {tasks.loading ? <Rows n={4} />
        : tasks.error ? <ErrorBlock error={tasks.error} onRetry={tasks.reload} />
          : !tasks.data.length ? <Blank title="Nothing here" />
            : tasks.data.map((t) => <TaskRow key={t.task_id} task={t} onOpen={() => onOpenTask(t.task_id)} />)}
    </div>
  );
}

function TaskDetail({ id, onBack }) {
  const T = useT();
  const api = useApi();
  const task = useResource(() => api.task(id), [id]);
  const [mode, setMode] = useState('view');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const run = async (fn) => {
    setBusy(true); setProblem(null);
    try { await fn(); await task.reload(); setMode('view'); }
    catch (e) { setProblem(e); }
    finally { setBusy(false); }
  };

  if (task.loading) return <div style={{ padding: '28px 24px' }}><Skel h={24} w="60%" /><div style={{ height: 20 }} /><Rows /></div>;
  if (task.error) return <div style={{ padding: '28px 24px' }}><BackLink onBack={onBack} /><ErrorBlock error={task.error} onRetry={task.reload} /></div>;

  const t = task.data;
  const returned = (t.submissions || []).filter((s) => s.review_status === 'Returned').slice(-1)[0];

  return (
    <div style={{ padding: '28px 24px 60px' }}>
      <BackLink onBack={onBack} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <M style={{ fontSize: 11, color: T.faint }}>{t.task_code}</M>
        <Status state={t.effective_status || t.status} />
      </div>
      <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, margin: '0 0 20px' }}>{t.title}</h1>

      {returned && (
        <div className="pop" style={{ paddingLeft: 14, borderLeft: `2px solid ${T.accent}`, marginBottom: 24 }}>
          <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: T.accent, marginBottom: 6 }}>Returned</div>
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>{returned.return_reason}</div>
        </div>
      )}

      <p style={{ fontSize: 14, lineHeight: 1.6, color: T.mute, marginBottom: 32 }}>
        {t.description || 'No further description was added.'}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, paddingTop: 24, borderTop: `1px solid ${T.line}`, marginBottom: 32 }}>
        {[['Assigned by', t.assigner_name], ['Deadline', to12(t.due_time)],
          ['Started', istTime(t.started_at)], ['Submitted', istTime(t.submitted_at)]].map(([k, v]) => (
          <div key={k}>
            <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: T.faint, marginBottom: 6 }}>{k}</div>
            <div style={{ fontSize: 14 }}>{v || '—'}</div>
          </div>
        ))}
      </div>

      {problem && <div className="fade" style={{ fontSize: 13, color: T.accent, marginBottom: 20 }}>{problem.message}</div>}

      {mode === 'view' && (<>
        {['Not Started', 'Returned'].includes(t.status) &&
          <Btn variant="accent" full busy={busy} onClick={() => run(() => api.startTask(t.task_id))}>Start work</Btn>}
        {t.status === 'In Progress' &&
          <Btn variant="accent" full onClick={() => setMode('submit')}>Submit work</Btn>}
        {t.status === 'Submitted' &&
          <div style={{ fontSize: 12, color: T.mute, textAlign: 'center', padding: '12px 0' }}>
            Submitted at {istTime(t.submitted_at)}, waiting for verification
          </div>}
        {t.status === 'Completed' &&
          <div className="pop" style={{ fontSize: 12, color: T.mute, textAlign: 'center', padding: '12px 0' }}>
            Approved at {istTime(t.completed_at)}
          </div>}
      </>)}

      {mode === 'submit' && (
        <div className="rise" style={{ paddingTop: 28, borderTop: `1px solid ${T.line}` }}>
          <Eyebrow>Submit work</Eyebrow>
          <Field label="What did you complete?">
            <textarea rows={3} value={description} autoFocus onChange={(e) => setDescription(e.target.value)}
              placeholder="What is done, and anything the reviewer should check."
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 14, background: 'transparent', border: `1px solid ${T.line}`, color: T.text, outline: 'none', resize: 'vertical' }} />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="line" full onClick={() => setMode('view')}>Cancel</Btn>
            <Btn variant="accent" full busy={busy} disabled={!description.trim()}
              onClick={() => run(() => api.submitTask(t.task_id, { description: description.trim() }))}>Submit</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function BackLink({ onBack }) {
  const T = useT();
  return (
    <button className="press" onClick={onBack} style={{ background: 'none', border: 'none', color: T.mute, fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: 32 }}>
      ← Back
    </button>
  );
}

function EAttendance({ profile }) {
  const T = useT();
  const api = useApi();
  const history = useResource(() => api.myAttendance(), []);
  return (
    <div style={{ padding: '32px 24px 0' }}>
      <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: '0 0 32px' }}>Attendance</h1>
      <div style={{ fontSize: 12, color: T.mute, marginBottom: 24 }}>
        {profile.data ? `${profile.data.site_name}, ${profile.data.radius_metres} m radius` : ''}
      </div>
      <Eyebrow>History</Eyebrow>
      {history.loading ? <Rows n={5} />
        : history.error ? <ErrorBlock error={history.error} onRetry={history.reload} />
          : !history.data.length ? <Blank title="No attendance recorded yet" />
            : <div style={{ borderTop: `1px solid ${T.line}` }}>
              {history.data.map((a) => (
                <div key={a.attendance_id} className="row" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
                  <M style={{ fontSize: 11, color: T.faint, width: 48, flexShrink: 0 }}>{istDateShort(a.work_date)}</M>
                  <div style={{ flex: 1 }}><Status state={a.status} /></div>
                  <M style={{ fontSize: 11, color: T.mute }}>
                    {a.check_in_time ? `${istTime(a.check_in_time)} – ${a.check_out_time ? istTime(a.check_out_time) : '—'}` : ''}
                  </M>
                </div>
              ))}
            </div>}
      <div style={{ height: 40 }} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ claims */

function EClaims({ profile }) {
  const T = useT();
  const api = useApi();
  const claims = useResource(() => api.myClaims(), []);
  const [adding, setAdding] = useState(false);

  const total = (claims.data || []).reduce((s, c) => s + Number(c.amount_paise), 0);
  const pending = (claims.data || []).filter((c) => c.status === 'Pending')
    .reduce((s, c) => s + Number(c.amount_paise), 0);

  return (
    <div style={{ padding: '32px 24px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 32 }}>
        <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Claims</h1>
        <Btn variant="line" onClick={() => setAdding(true)}>Add</Btn>
      </div>

      {claims.loading ? <Skel h={40} w="50%" />
        : claims.error ? <ErrorBlock error={claims.error} onRetry={claims.reload} />
          : (<>
            <div style={{ marginBottom: 36 }}>
              <Eyebrow>Claimed</Eyebrow>
              <div className="tight" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1 }}>{rupees(total)}</div>
              {pending > 0 && <div style={{ fontSize: 12, color: T.accent, marginTop: 10 }}>{rupees(pending)} awaiting approval</div>}
            </div>

            <Eyebrow>History</Eyebrow>
            {!claims.data.length ? <Blank title="No claims yet" hint="Add one with a photo of the bill." />
              : <div style={{ borderTop: `1px solid ${T.line}` }}>
                {claims.data.map((c) => (
                  <div key={c.claim_id} style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{c.category}</div>
                      <M style={{ fontSize: 11, color: T.faint }}>{istDateShort(c.claim_date)}</M>
                      {c.place && <div style={{ fontSize: 12, color: T.mute, marginTop: 4 }}>{c.place}</div>}
                      {c.location && <div style={{ fontSize: 12, color: T.mute, marginTop: 4 }}>{c.location}</div>}
                      {c.reject_reason && <div style={{ fontSize: 12, color: T.accent, marginTop: 6 }}>{c.reject_reason}</div>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <M style={{ fontSize: 14, fontWeight: 500, display: 'block' }}>{rupees(c.amount_paise)}</M>
                      <div style={{ marginTop: 6 }}><Status state={c.status} /></div>
                    </div>
                  </div>
                ))}
              </div>}
          </>)}

      {adding && <ClaimForm caps={profile.data} onClose={() => setAdding(false)} onDone={() => { setAdding(false); claims.reload(); }} />}
      <div style={{ height: 40 }} />
    </div>
  );
}

function ClaimForm({ caps, onClose, onDone }) {
  const T = useT();
  const api = useApi();
  // One key for this form. Tapping Submit twice files one claim, not two.
  const actionKey = useRef(newActionKey());
  const [category, setCategory] = useState('Travel');
  const [amount, setAmount] = useState('');
  const [place, setPlace] = useState('');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const capFor = { Food: caps?.cap_food, Stay: caps?.cap_stay }[category];

  const submit = async () => {
    setBusy(true); setProblem(null);
    try {
      // The bill is uploaded first so the claim can reference it. The
      // server rejects a claim whose attachment is missing or reused.
      const uploaded = await api.uploadFile(file);
      await api.createClaim({
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
        category, amount: Number(amount), attachmentId: uploaded.attachment_id,
        ...(category === 'Travel' ? { place: place.trim() } : {}),
        ...(category === 'Stay' ? { location: location.trim() } : {}),
        ...(category === 'Others' ? { note: note.trim() } : {}),
      }, actionKey.current);
      onDone();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const incomplete = !file || !amount || Number(amount) <= 0
    || (category === 'Travel' && !place.trim())
    || (category === 'Stay' && !location.trim())
    || (category === 'Others' && !note.trim());

  return (
    <div className="fade" style={{ position: 'fixed', inset: 0, background: T.overlay, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50 }}>
      <div className="rise" style={{ width: '100%', maxWidth: 420, background: T.bg, padding: 28, borderTop: `1px solid ${T.line}`, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 28 }}>
          <div className="tight" style={{ fontSize: 18, fontWeight: 600 }}>New claim</div>
          <button className="press" onClick={onClose} style={{ background: 'none', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>

        <Field label="Category">
          <div style={{ display: 'flex', gap: 8 }}>
            {['Travel', 'Food', 'Stay', 'Others'].map((c) => (
              <button key={c} className="press" onClick={() => { setCategory(c); setProblem(null); }} style={{
                flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                background: category === c ? T.text : 'transparent', color: category === c ? T.bg : T.mute,
                border: `1px solid ${category === c ? T.text : T.line}`,
              }}>{c}</button>
            ))}
          </div>
        </Field>

        <Field label="Bill">
          <label className="press" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', borderRadius: 8, border: `1px dashed ${file ? T.line : T.accent}`, color: file ? T.text : T.mute, cursor: 'pointer', fontSize: 14 }}>
            {file ? file.name : 'Upload bill'}
            <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
              onChange={(e) => { setFile(e.target.files?.[0] || null); setProblem(null); }} />
          </label>
        </Field>

        <Field label="Amount" error={null}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.line}`, borderRadius: 8, padding: '0 12px' }}>
            <M style={{ fontSize: 14, color: T.faint }}>₹</M>
            <input type="number" inputMode="decimal" value={amount} placeholder="0"
              onChange={(e) => { setAmount(e.target.value); setProblem(null); }}
              className="mono" style={{ flex: 1, padding: '10px 0', border: 'none', background: 'transparent', color: T.text, outline: 'none', fontSize: 14 }} />
          </div>
          {capFor && <div style={{ fontSize: 12, color: T.mute, marginTop: 8 }}>Daily limit ₹{capFor}. The server checks the day's total.</div>}
        </Field>

        {category === 'Travel' && <Field label="Travel place"><Input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Office to ABC School" /></Field>}
        {category === 'Stay' && <Field label="Location"><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Vellore" /></Field>}
        {category === 'Others' && <Field label="What was it for?"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Courier charges" /></Field>}

        {problem && (
          <div className="fade" style={{ fontSize: 13, color: T.accent, marginBottom: 20, lineHeight: 1.5 }}>
            {problem.message}
            {problem.details?.remaining !== undefined &&
              <div style={{ fontSize: 12, color: T.mute, marginTop: 6 }}>₹{problem.details.remaining} still available today.</div>}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="line" full onClick={onClose}>Cancel</Btn>
          <Btn variant="accent" full busy={busy} disabled={incomplete} onClick={submit}>Submit claim</Btn>
        </div>
      </div>
    </div>
  );
}

function EProfile({ profile, onOut, theme, setTheme, onOpenNews }) {
  const T = useT();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const p = profile.data;

  const signOut = async () => {
    setBusy(true);
    try { await api.logout(); } finally { onOut(); }
  };

  return (
    <div style={{ padding: '32px 24px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Profile</h1>
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </div>

      {profile.loading ? <Rows />
        : profile.error ? <ErrorBlock error={profile.error} onRetry={profile.reload} />
          : (<>
            <div style={{ marginBottom: 36 }}>
              <div style={{ fontSize: 18, fontWeight: 500 }}>{p.name}</div>
              <div style={{ fontSize: 14, color: T.mute, marginTop: 2 }}>{p.role}</div>
            </div>
            <div style={{ display: 'grid', gap: 16, paddingTop: 24, borderTop: `1px solid ${T.line}`, marginBottom: 40 }}>
              {[['Employee ID', p.employee_code], ['Email', p.email], ['Phone', p.phone || '—'],
                ['Check-in site', p.site_name], ['Radius', `${p.radius_metres} m`],
                ['Reimbursement', p.claims_enabled ? 'Enabled' : 'Not enabled'],
                ...(p.claims_enabled ? [['Food limit', `₹${p.cap_food} a day`], ['Stay limit', `₹${p.cap_stay} a day`]] : []),
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 14 }}>
                  <span style={{ color: T.mute }}>{k}</span><span>{v}</span>
                </div>
              ))}
            </div>
          </>)}

      <p style={{ fontSize: 12, lineHeight: 1.6, color: T.faint, marginBottom: 32 }}>
        Your location is read only when you check in or check out. It is never tracked in between,
        saved records cannot be edited, and coordinates are deleted after 90 days.
      </p>
      <div style={{ marginBottom: 12 }}>
        <Btn variant="line" full onClick={onOpenNews}>Announcements</Btn>
      </div>
      <Btn variant="line" full busy={busy} onClick={signOut}>Sign out</Btn>
      <div style={{ height: 40 }} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ admin web */

function Admin({ me, onOut, theme, setTheme }) {
  const T = useT();
  const api = useApi();
  const isPhone = useIsPhone();
  const [page, setPage] = useState('dashboard');
  const nav = [['dashboard', 'Today'], ['news', 'Notices'], ['words', 'Words'], ['claims', 'Claims'], ['employees', 'Team'], ['audit', 'Audit']];

  const body = (
    <main key={page} className="rise" style={{
      flex: 1, minWidth: 0,
      padding: isPhone ? '24px 20px 92px' : '48px 48px',
      maxWidth: isPhone ? '100%' : 1100,
    }}>
      {page === 'dashboard' && <ADash isPhone={isPhone} />}
      {page === 'news' && <ANews isPhone={isPhone} />}
      {page === 'words' && <AWords isPhone={isPhone} />}
      {page === 'claims' && <AClaims isPhone={isPhone} />}
      {page === 'employees' && <AEmployees isPhone={isPhone} />}
      {page === 'audit' && <AAudit />}
    </main>
  );

  // On a phone the sidebar becomes bottom navigation, the same pattern the
  // employee app uses. A fixed 210px rail beside wide tables is what made
  // the page scroll sideways.
  if (isPhone) {
    return (
      <div style={{ minHeight: '100vh', maxWidth: '100%', overflowX: 'hidden' }}>
        <header style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', borderBottom: `1px solid ${T.line}`,
          position: 'sticky', top: 0, background: T.bg, zIndex: 20,
        }}>
          <Brand size={22} showName={false} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ThemeToggle theme={theme} setTheme={setTheme} />
            <button className="press" onClick={async () => { try { await api.logout(); } finally { onOut(); } }}
              style={{ background: 'none', border: 'none', color: T.mute, fontSize: 12, cursor: 'pointer', padding: 8 }}>
              Sign out
            </button>
          </div>
        </header>

        {body}

        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex',
          background: T.bg, borderTop: `1px solid ${T.line}`, zIndex: 20,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}>
          {nav.map(([k, label]) => (
            <button key={k} className="press" onClick={() => setPage(k)} style={{
              flex: 1, padding: '14px 0', background: 'none', border: 'none', cursor: 'pointer',
              color: page === k ? T.text : T.faint, fontSize: 12, position: 'relative',
            }}>
              {page === k && <span style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 18, height: 1.5, background: T.accent }} />}
              {label}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: 210, flexShrink: 0, borderRight: `1px solid ${T.line}`, padding: '28px 20px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 36 }}><Brand size={24} /></div>
        {nav.map(([k, label]) => (
          <button key={k} className="press" onClick={() => setPage(k)} style={{
            background: 'none', border: 'none', textAlign: 'left', padding: '8px 0', cursor: 'pointer',
            fontSize: 14, color: page === k ? T.text : T.mute, fontWeight: page === k ? 500 : 400,
          }}>{label}</button>
        ))}
        <div style={{ marginTop: 'auto' }}>
          <div style={{ fontSize: 12, color: T.mute, marginBottom: 8 }}>{me.name}</div>
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <button className="press" onClick={async () => { try { await api.logout(); } finally { onOut(); } }}
            style={{ background: 'none', border: 'none', color: T.mute, fontSize: 12, cursor: 'pointer', padding: 8 }}>Sign out</button>
        </div>
      </aside>
      {body}
    </div>
  );
}

function ADash({ isPhone }) {
  const T = useT();
  const api = useApi();
  const dash = useResource(() => api.admin.dashboard(), []);

  if (dash.loading) return (<><h1 className="tight" style={{ fontSize: 24, fontWeight: 600 }}>Today</h1><div style={{ height: 32 }} /><Rows n={4} /></>);
  if (dash.error) return <ErrorBlock error={dash.error} onRetry={dash.reload} />;

  const { work, board, businessDate } = dash.data;
  const present = board.filter((b) => b.check_in_time).length;

  return (
    <>
      <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Today</h1>
      <M style={{ fontSize: 11, color: T.mute, display: 'block', marginTop: 10, marginBottom: 40 }}>{istDateLong(businessDate)}</M>

      <div style={{
        display: 'grid',
        gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(auto-fit,minmax(160px,1fr))',
        gap: isPhone ? 24 : 32, marginBottom: isPhone ? 36 : 48,
      }}>
        {[['Present', `${present} / ${board.length}`, false],
          ['Completed', `${work.completed} / ${work.assigned}`, false],
          ['Overdue', work.overdue, Number(work.overdue) > 0],
          ['To review', work.submitted, false]].map(([label, value, alert]) => (
          <div key={label}>
            <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em', color: T.faint, marginBottom: 12 }}>{label}</div>
            <div className="tight" style={{ fontSize: isPhone ? 30 : 40, fontWeight: 600, lineHeight: 1, color: alert ? T.accent : T.text }}>{value}</div>
          </div>
        ))}
      </div>

      <Eyebrow>Team</Eyebrow>
      <div style={{ borderTop: `1px solid ${T.line}` }}>
        {board.map((b) => (
          <div key={b.employee_id} className="row" style={{ padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{b.name}</div>
                <div style={{ fontSize: 12, color: T.mute, marginTop: 2 }}>{b.role}</div>
              </div>
              <Status state={b.attendance_status} />
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
              <M style={{ fontSize: 12, color: T.mute }}>{b.completed}/{b.tasks_assigned} done</M>
              {Number(b.overdue) > 0 && <M style={{ fontSize: 12, color: T.accent }}>{b.overdue} overdue</M>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ANews({ isPhone }) {
  const T = useT();
  const api = useApi();
  const list = useResource(() => api.admin.broadcasts(), []);
  return <AdminBroadcasts T={T} api={api} list={list} isPhone={isPhone} />;
}

function AWords({ isPhone }) {
  const T = useT();
  const api = useApi();
  const results = useResource(() => api.admin.latResults(), []);
  return <AdminLat T={T} api={api} results={results} onPublished={results.reload} isPhone={isPhone} />;
}

function AClaims({ isPhone }) {
  const T = useT();
  const api = useApi();
  const [status, setStatus] = useState('Pending');
  const claims = useResource(() => api.admin.claims(status), [status]);
  const [acting, setActing] = useState(null);

  const decide = async (id, decision, reason) => {
    setActing(id);
    try { await api.admin.decideClaim(id, { decision, ...(reason ? { reason } : {}) }, newActionKey()); await claims.reload(); }
    catch (e) { alert(e.message); }
    finally { setActing(null); }
  };

  return (
    <>
      <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 32px' }}>Claims</h1>
      <div style={{ display: 'flex', gap: 24, borderBottom: `1px solid ${T.line}`, marginBottom: 8 }}>
        {['Pending', 'Approved', 'Rejected'].map((s) => (
          <button key={s} className="press" onClick={() => setStatus(s)} style={{
            background: 'none', border: 'none', padding: '0 0 12px', cursor: 'pointer', fontSize: 12,
            color: status === s ? T.text : T.faint, fontWeight: status === s ? 500 : 400,
            borderBottom: status === s ? `1.5px solid ${T.accent}` : '1.5px solid transparent',
          }}>{s}</button>
        ))}
      </div>

      {claims.loading ? <Rows n={3} />
        : claims.error ? <ErrorBlock error={claims.error} onRetry={claims.reload} />
          : !claims.data.length ? <Blank title={`No ${status.toLowerCase()} claims`} />
            : claims.data.map((c) => (
              <div key={c.claim_id} style={{ display: 'flex', gap: isPhone ? 12 : 20, alignItems: 'flex-start', flexWrap: 'wrap', padding: '20px 0', borderBottom: `1px solid ${T.line}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{c.employee_name} · {c.category}</div>
                  <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 4 }}>{istDateShort(c.claim_date)}</M>
                  {(c.place || c.location || c.note) && <div style={{ fontSize: 13, color: T.mute, marginTop: 6 }}>{c.place || c.location || c.note}</div>}
                </div>
                <M style={{ fontSize: 16, fontWeight: 500 }}>{rupees(c.amount_paise)}</M>
                {c.status === 'Pending' ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn variant="line" busy={acting === c.claim_id}
                      onClick={() => { const r = prompt('Reason for rejection'); if (r?.trim()) decide(c.claim_id, 'Rejected', r.trim()); }}>Reject</Btn>
                    <Btn variant="solid" busy={acting === c.claim_id} onClick={() => decide(c.claim_id, 'Approved')}>Approve</Btn>
                  </div>
                ) : <Status state={c.status} />}
              </div>
            ))}
    </>
  );
}

function AEmployees({ isPhone }) {
  const T = useT();
  const api = useApi();
  const staff = useResource(() => api.admin.employees(), []);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 32 }}>
        <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Employees</h1>
        <Btn onClick={() => setAdding(true)}>Add employee</Btn>
      </div>

      {staff.loading ? <Rows n={5} />
        : staff.error ? <ErrorBlock error={staff.error} onRetry={staff.reload} />
          : <div style={{ borderTop: `1px solid ${T.line}` }}>
            {staff.data.map((e) => (
              <div key={e.employee_id} className="row" style={{ padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{e.name}</div>
                    <M style={{ fontSize: 11, color: T.faint, wordBreak: 'break-all' }}>{e.employee_code} · {e.email}</M>
                  </div>
                  <Status state={e.status === 'Active' ? 'Completed' : 'Absent'} />
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: T.mute }}>{e.role}{e.is_admin ? ' · admin' : ''}</span>
                  <M style={{ fontSize: 12, color: e.claims_enabled ? T.text : T.faint }}>
                    {e.claims_enabled ? `₹${e.cap_food} / ₹${e.cap_stay}` : 'no reimbursement'}
                  </M>
                </div>
              </div>
            ))}
          </div>}

      {adding && (
        <AddEmployee isPhone={isPhone} onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); staff.reload(); }} />
      )}
    </>
  );
}

/**
 * Creating an account is the one place an admin sets someone else's
 * password, so the form states plainly that it must be passed on: there is
 * no invite email in this system and adding a mail service is not
 * warranted for a team of this size.
 */
function AddEmployee({ onClose, onDone, isPhone }) {
  const T = useT();
  const api = useApi();
  const [f, setF] = useState({
    name: '', role: 'Trainer', email: '', phone: '', password: '',
    claimsEnabled: false, capFood: 500, capStay: 1500,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [created, setCreated] = useState(null);

  const set = (patch) => { setF({ ...f, ...patch }); setProblem(null); };
  const incomplete = !f.name.trim() || !f.email.trim() || f.password.length < 12;

  const submit = async () => {
    setBusy(true); setProblem(null);
    try {
      const emp = await api.admin.createEmployee({
        name: f.name.trim(), role: f.role, email: f.email.trim().toLowerCase(),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        password: f.password, isAdmin: false,
        claimsEnabled: f.claimsEnabled,
        capFood: Number(f.capFood) || 0, capStay: Number(f.capStay) || 0,
      });
      setCreated({ ...emp, password: f.password });
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const label = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: T.faint, marginBottom: 8 };
  const field = {
    width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 14, background: 'transparent',
    border: `1px solid ${T.line}`, color: T.text, outline: 'none', fontFamily: 'inherit',
  };

  return (
    <div className="fade" style={{
      position: 'fixed', inset: 0, background: T.overlay, zIndex: 60,
      display: 'flex', alignItems: isPhone ? 'flex-end' : 'center', justifyContent: 'center', padding: isPhone ? 0 : 16,
    }}>
      <div className="rise" style={{
        width: '100%', maxWidth: 480, background: T.bg, padding: 28,
        borderRadius: isPhone ? '16px 16px 0 0' : 16, border: `1px solid ${T.line}`,
        maxHeight: '92vh', overflowY: 'auto',
      }}>
        {created ? (
          <>
            <div className="tight" style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
              {created.name} added
            </div>
            <div style={{ fontSize: 13, color: T.mute, lineHeight: 1.6, marginBottom: 24 }}>
              Give them these details. The password is not shown again, and there is
              no email invitation — you pass it on yourself.
            </div>
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 12, padding: 16, marginBottom: 24 }}>
              {[['Employee ID', created.employee_code], ['Email', created.email], ['Password', created.password]].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
                  <span style={{ fontSize: 12, color: T.mute }}>{k}</span>
                  <M style={{ fontSize: 13, wordBreak: 'break-all', textAlign: 'right' }}>{v}</M>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="line" full onClick={() => { setCreated(null); setF({ ...f, name: '', email: '', phone: '', password: '' }); }}>
                Add another
              </Btn>
              <Btn full onClick={onDone}>Done</Btn>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
              <div className="tight" style={{ fontSize: 18, fontWeight: 600 }}>Add employee</div>
              <button className="press" onClick={onClose}
                style={{ background: 'none', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16 }}>×</button>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div className="mono" style={label}>Name</div>
              <input value={f.name} autoFocus onChange={(e) => set({ name: e.target.value })}
                placeholder="Full name" style={field} />
            </div>

            <div style={{ marginBottom: 20 }}>
              <div className="mono" style={label}>Role</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {['Trainer', 'Admin', 'Accountant', 'Content Writer', 'Designer'].map((r) => {
                  const on = f.role === r;
                  return (
                    <button key={r} className="press" onClick={() => set({ role: r })} style={{
                      padding: '8px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                      background: on ? T.text : 'transparent', color: on ? T.bg : T.mute,
                      border: `1px solid ${on ? T.text : T.line}`,
                    }}>{r}</button>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, color: T.faint, marginTop: 8 }}>
                Trainers check in at a school; everyone else at the office.
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <div>
                <div className="mono" style={label}>Email (their login)</div>
                <input value={f.email} type="email" onChange={(e) => set({ email: e.target.value })}
                  placeholder="name@company.in" style={field} />
              </div>
              <div>
                <div className="mono" style={label}>Phone</div>
                <input value={f.phone} onChange={(e) => set({ phone: e.target.value })}
                  placeholder="+91" style={{ ...field, fontFamily: '"JetBrains Mono", monospace' }} />
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div className="mono" style={label}>Password</div>
              <input value={f.password} onChange={(e) => set({ password: e.target.value })}
                placeholder="At least 12 characters" style={field} />
              <div style={{ fontSize: 12, color: f.password && f.password.length < 12 ? T.accent : T.faint, marginTop: 8 }}>
                {f.password && f.password.length < 12
                  ? `${12 - f.password.length} more characters needed`
                  : 'You choose it and tell them. They can change it later.'}
              </div>
            </div>

            <div style={{ paddingTop: 20, borderTop: `1px solid ${T.line}`, marginBottom: 20 }}>
              <button className="press" onClick={() => set({ claimsEnabled: !f.claimsEnabled })}
                style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', color: T.text }}>
                <span style={{
                  width: 34, height: 20, borderRadius: 999, position: 'relative', flexShrink: 0,
                  background: f.claimsEnabled ? T.accent : T.line, transition: 'background .18s',
                }}>
                  <span style={{
                    position: 'absolute', width: 14, height: 14, borderRadius: '50%', top: 3,
                    left: f.claimsEnabled ? 17 : 3, background: T.bg, transition: 'left .18s cubic-bezier(.2,.8,.3,1)',
                  }} />
                </span>
                <span>
                  <span style={{ fontSize: 14, display: 'block' }}>Reimbursement</span>
                  <span style={{ fontSize: 12, color: T.mute }}>Adds the Claims tab to their app</span>
                </span>
              </button>
            </div>

            {f.claimsEnabled && (
              <div className="rise" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                {[['Food, per day', 'capFood'], ['Stay, per day', 'capStay']].map(([lbl, k]) => (
                  <div key={k}>
                    <div className="mono" style={label}>{lbl}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.line}`, borderRadius: 8, padding: '0 12px' }}>
                      <M style={{ fontSize: 14, color: T.faint }}>₹</M>
                      <input type="number" value={f[k]} onChange={(e) => set({ [k]: e.target.value })}
                        className="mono" style={{ flex: 1, padding: '10px 0', border: 'none', background: 'transparent', color: T.text, outline: 'none', fontSize: 14 }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {problem && (
              <div className="fade" style={{ fontSize: 13, color: T.accent, marginBottom: 16, lineHeight: 1.5 }}>
                {problem.message}
                {problem.details?.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                    {problem.details.map((d, i) => <li key={i}>{d.field}: {d.message}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="line" full onClick={onClose}>Cancel</Btn>
              <Btn full busy={busy} disabled={incomplete} onClick={submit}>Create account</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AAudit() {
  const T = useT();
  const api = useApi();
  const log = useResource(() => api.admin.audit(), []);
  return (
    <>
      <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 32px' }}>Audit trail</h1>
      {log.loading ? <Rows n={6} />
        : log.error ? <ErrorBlock error={log.error} onRetry={log.reload} />
          : !log.data.length ? <Blank title="No activity recorded yet" />
            : <div style={{ borderTop: `1px solid ${T.line}` }}>
              {log.data.map((l) => (
                <div key={l.audit_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
                  <span style={{ fontWeight: 500, width: 140 }}>{l.actor_name || 'system'}</span>
                  <span style={{ color: T.mute }}>{l.action}</span>
                  <span style={{ color: T.mute }}>{l.entity}</span>
                  <M style={{ fontSize: 11, color: T.faint, marginLeft: 'auto' }}>{istTime(l.created_at)}</M>
                </div>
              ))}
            </div>}
    </>
  );
}
