import React, { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react';
import { createClient, ApiError, readFix, newActionKey } from './api-client.js';
import { LatCard, LatScreen, AdminLat } from './Lat.jsx';
import { BroadcastCard, BroadcastList, AdminBroadcasts } from './Broadcast.jsx';
import { AdminSchools } from './Schools.jsx';
import { PunchPanel } from './Punch.jsx';

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

  // Restore a valid session after a page refresh without bypassing server auth.
  useEffect(() => {
    if (api.session && !session) setSession(api.session);
  }, [api, session]);

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

          <Btn type="submit" variant="solid" full busy={busy}>
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
  const isPhone = useIsPhone();
  const [tab, setTab] = useState('home');
  const [openTask, setOpenTask] = useState(null);
  const [latOpen, setLatOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const profile = useResource(() => api.me(), []);
  const lat = useResource(() => api.latToday(), []);
  const broadcasts = useResource(() => api.broadcasts(), []);
  const notifications = useResource(() => api.notifications(), []);
  useEffect(() => { const id = setInterval(() => notifications.reload(), 60000); return () => clearInterval(id); }, [notifications.reload]);

  const nav = [
    ['home', 'Home'], ['tasks', 'Tasks'], ['attendance', 'Attendance'], ['lat', 'LAT'],
    ['contributions', 'Contributions'], ['workdone', 'Work Done'],
    ...(profile.data?.claims_enabled ? [['claims', 'Claims']] : []),
    ['profile', 'Profile'],
  ];

  const selectTab = (k) => {
    setOpenTask(null); setLatOpen(false); setNewsOpen(false); setTab(k); setSidebarOpen(false);
  };

  const content = (
    <div key={newsOpen ? 'news' : latOpen ? 'lat' : openTask || tab} className="rise">
      {newsOpen ? <BroadcastList T={T} api={api} broadcasts={broadcasts} onBack={() => setNewsOpen(false)} />
        : latOpen ? <LatScreen T={T} api={api} lat={lat} onBack={() => { setLatOpen(false); lat.reload(); }} />
        : openTask ? <TaskDetail id={openTask} onBack={() => setOpenTask(null)} />
        : tab === 'home' ? <EHome me={me} profile={profile} onOpenTask={setOpenTask} lat={lat}
            onOpenLat={() => setLatOpen(true)} broadcasts={broadcasts} onOpenNews={() => setNewsOpen(true)} />
          : tab === 'tasks' ? <ETasks onOpenTask={setOpenTask} />
            : tab === 'attendance' ? <EAttendance profile={profile} />
              : tab === 'lat' ? <ELat lat={lat} onOpen={() => setLatOpen(true)} />
                : tab === 'claims' ? <EClaims profile={profile} />
                : tab === 'contributions' ? <EContributions />
                : tab === 'workdone' ? <EWorkDone />
                : <EProfile profile={profile} onOut={onOut} theme={theme} setTheme={setTheme} onOpenNews={() => setNewsOpen(true)} />}
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text }}>
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 20px', borderBottom: `1px solid ${T.line}`,
        position: 'sticky', top: 0, background: T.bg, zIndex: 20,
      }}>
        <button className="press" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"
          style={{ background: 'none', border: 'none', color: T.text, fontSize: 22, cursor: 'pointer', padding: 4, lineHeight: 1 }}>☰</button>
        <Brand size={22} showName={false} />
        <div style={{display:'flex',alignItems:'center',gap:10}}><NotificationBell T={T} notifications={notifications} /><ThemeToggle theme={theme} setTheme={setTheme} /></div>
      </header>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 57px)' }}>
        {!isPhone && <aside style={{
          width: 220, flexShrink: 0, borderRight: `1px solid ${T.line}`, padding: '24px 14px',
          display: 'flex', flexDirection: 'column', gap: 4, position: 'sticky', top: 57, height: 'calc(100vh - 57px)', boxSizing: 'border-box',
        }}>
          <div style={{ padding: '0 10px 20px' }}><Brand size={22} /></div>
          {nav.map(([k, label]) => {
            const on = tab === k && !openTask && !latOpen && !newsOpen;
            return <button key={k} className="press" onClick={() => selectTab(k)}
              style={{ textAlign: 'left', padding: '11px 12px', borderRadius: 8, background: on ? T.soft : 'none', border: 'none', cursor: 'pointer', color: on ? T.text : T.mute, fontSize: 13, fontWeight: on ? 600 : 400 }}>
              {label}
            </button>;
          })}
        </aside>}

        <main style={{ flex: 1, minWidth: 0, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
          {content}
        </main>
      </div>

      {sidebarOpen && (
        <>
          <div onClick={() => setSidebarOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 40 }} />
          <aside className="rise" style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: '82%', maxWidth: 320, background: T.bg, borderRight: `1px solid ${T.line}`, zIndex: 50, padding: '24px 20px', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
              <Brand size={24} />
              <button className="press" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" style={{ background: 'none', border: 'none', color: T.mute, fontSize: 24, cursor: 'pointer' }}>×</button>
            </div>
            {nav.map(([k, label]) => {
              const on = tab === k && !openTask && !latOpen && !newsOpen;
              return <button key={k} className="press" onClick={() => selectTab(k)}
                style={{ textAlign: 'left', padding: '13px 12px', borderRadius: 8, background: on ? T.soft : 'none', border: 'none', cursor: 'pointer', color: on ? T.text : T.mute, fontSize: 14, fontWeight: on ? 600 : 400 }}>
                {label}
              </button>;
            })}
            <div style={{ marginTop: 'auto', paddingTop: 20, borderTop: `1px solid ${T.line}` }}>
              <button className="press" onClick={() => { setSidebarOpen(false); selectTab('profile'); }} style={{ width: '100%', textAlign: 'left', padding: '13px 12px', background: 'none', border: 'none', color: T.mute, fontSize: 13 }}>Profile & Settings</button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

function NotificationBell({ T, notifications }) {
  const [open,setOpen]=useState(false);
  const items=(notifications.data||[]).slice(0,8);
  const unread=items.filter(n=>!n.read_at).length;
  return <div style={{position:'relative'}}>
    <button className="press" onClick={()=>setOpen(v=>!v)} aria-label={`${unread} unread notifications`} style={{position:'relative',width:34,height:34,borderRadius:9,border:`1px solid ${T.line}`,background:'transparent',color:T.text,cursor:'pointer',fontSize:17}}>♢
      {unread>0&&<span style={{position:'absolute',top:5,right:5,width:7,height:7,borderRadius:'50%',background:T.accent}}/>}
    </button>
    {open&&<>
      <div onClick={()=>setOpen(false)} style={{position:'fixed',inset:0,zIndex:25}}/>
      <div className="rise" style={{position:'absolute',right:0,top:42,width:'min(330px, calc(100vw - 32px))',background:T.bg,border:`1px solid ${T.line}`,borderRadius:12,boxShadow:'0 12px 35px rgba(0,0,0,.18)',zIndex:30,overflow:'hidden'}}>
        <div style={{padding:'13px 15px',borderBottom:`1px solid ${T.line}`,fontSize:13,fontWeight:600}}>Notifications</div>
        {!items.length?<div style={{padding:18,fontSize:12,color:T.mute}}>No notifications.</div>:items.map(n=><div key={n.notification_id} style={{padding:'12px 15px',borderBottom:`1px solid ${T.hair}`,fontSize:12,lineHeight:1.5}}><div>{n.body}</div><div style={{fontSize:10,color:T.faint,marginTop:5}}>{istTime(n.created_at)}</div></div>)}
      </div>
    </>}
  </div>;
}

function EHome({ me, profile, onOpenTask, lat, onOpenLat, broadcasts, onOpenNews }) {
  const T = useT();
  const api = useApi();
  const attendance = useResource(() => api.myAttendance(), []);
  const tasks = useResource(() => api.myTasks('today'), []);
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  // Only an open session controls the Punch panel. Closed sessions are history
  // and must never block a later Punch In on the same business day.
  const att = (attendance.data || []).find((a) =>
    String(a.work_date).slice(0, 10) === todayKey && a.check_in_time && !a.check_out_time) || null;

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

      <PunchPanel T={T} api={api} att={att} role={profile.data?.role || me?.role} loading={attendance.loading} error={attendance.error}
        todayTasks={tasks.data || []} onTasksDone={tasks.reload}
        onDone={attendance.reload} onRetryLoad={attendance.reload} M={M} Btn={Btn} />

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

function ELat({ lat, onOpen }) {
  const T = useT();
  const data = lat.data;
  const count = data?.words?.length || data?.prompts?.length || data?.total || 0;

  return (
    <div style={{ padding: '32px 24px 0' }}>
      <div style={{ marginBottom: 32 }}>
        <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em', color: T.faint, marginBottom: 10 }}>
          Learning And Teaching
        </div>
        <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>LAT</h1>
        <p style={{ fontSize: 13, color: T.mute, margin: '8px 0 0', lineHeight: 1.5 }}>
          Today’s 10-item learning activity.
        </p>
      </div>

      <div style={{ borderTop: `1px solid ${T.line}`, paddingTop: 20, marginBottom: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>Today’s LAT</div>
        <div style={{ fontSize: 13, color: T.mute, lineHeight: 1.5 }}>
          {lat.loading ? 'Loading today’s learning activity…'
            : lat.error ? 'Couldn’t load today’s LAT.'
              : data?.stage === 'none' ? 'Not published yet.'
                : data?.stage === 'done' ? `${data.score} / ${data.total} completed correctly.`
                  : `${count || 10} learning items are ready.`}
        </div>
      </div>

      {!lat.loading && !lat.error && data?.stage !== 'none' && (
        <button className="press" onClick={onOpen} style={{
          width: '100%', padding: '14px', borderRadius: 8, fontSize: 15, fontWeight: 500,
          background: data.stage === 'done' ? 'transparent' : T.accent,
          color: data.stage === 'done' ? T.text : '#fff',
          border: data.stage === 'done' ? `1px solid ${T.line}` : 'none', cursor: 'pointer',
        }}>
          {data.stage === 'read' ? 'Start LAT' : data.stage === 'test' ? 'Continue LAT' : 'View LAT result'}
        </button>
      )}

      {lat.error && (
        <button className="press" onClick={lat.reload} style={{ background: 'none', border: 'none', color: T.text, fontSize: 13, padding: '12px 0', cursor: 'pointer' }}>
          Try again
        </button>
      )}
    </div>
  );
}

function EWorkDone() {
  const T = useT();
  const api = useApi();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [date, setDate] = useState(today);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [saved, setSaved] = useState(false);
  const data = useResource(() => api.workDone(date, date), [date]);

  useEffect(() => {
    setSaved(false);
    setProblem(null);
    const existing = data.data?.[0];
    setSummary(existing?.summary || '');
  }, [data.data]);

  const save = async () => {
    if (!summary.trim() || date > today) return;
    setBusy(true); setProblem(null); setSaved(false);
    try {
      await api.saveWorkDone({ workDate: date, summary: summary.trim() }, newActionKey());
      await data.reload();
      setSaved(true);
    } catch (e) { setProblem(e); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ padding: '32px 24px 0' }}>
      <div style={{ marginBottom: 28 }}>
        <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Work Done</h1>
        <div style={{ fontSize: 12, color: T.mute, marginTop: 7 }}>Update what you actually completed on a specific day. This is separate from assigned work.</div>
      </div>

      <Field label="Date"><Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
      {data.loading ? <Rows n={2} /> : data.error ? <ErrorBlock error={data.error} onRetry={data.reload} /> : (
        <>
          <Field label="Work Done">
            <textarea rows={7} value={summary} onChange={(e) => { setSummary(e.target.value); setSaved(false); }}
              placeholder="Write what you actually completed, important follow-ups, school work, office work, or other contributions for this day…"
              style={{ width:'100%', boxSizing:'border-box', padding:12, border:`1px solid ${T.line}`, borderRadius:8, background:T.bg, color:T.text, resize:'vertical', fontSize:14, lineHeight:1.5 }} />
          </Field>
          {problem && <div style={{ fontSize:13, color:T.accent, marginBottom:14 }}>{problem.message}</div>}
          {saved && <div style={{ fontSize:12, color:T.mute, marginBottom:14 }}>Work Done updated for {istDateShort(date)}.</div>}
          <Btn variant="accent" full busy={busy} disabled={!summary.trim()} onClick={save}>{data.data?.length ? 'Update Work Done' : 'Save Work Done'}</Btn>
        </>
      )}

      <div style={{ marginTop: 36, marginBottom: 40 }}>
        <Eyebrow>Recent entries</Eyebrow>
        {(() => {
          const recent = data.data || [];
          return recent.length ? recent.map((x) => <div key={x.work_done_id} style={{ padding:'13px 0', borderTop:`1px solid ${T.line}` }}><div style={{ fontSize:12, fontWeight:500 }}>{istDateShort(x.work_date)}</div><div style={{ fontSize:12, color:T.mute, lineHeight:1.5, marginTop:5 }}>{x.summary}</div></div>) : <Blank title="No Work Done recorded for this date" />;
        })()}
      </div>
    </div>
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
        {profile.data ? ((profile.data.role === 'Trainer' || profile.data.role === 'Technical Support') ? 'Punch in/out from any location' : `${profile.data.site_name}, ${profile.data.radius_metres} m radius`) : ''}
      </div>
      <Eyebrow>History</Eyebrow>
      {history.loading ? <Rows n={5} />
        : history.error ? <ErrorBlock error={history.error} onRetry={history.reload} />
          : !history.data.length ? <Blank title="No attendance recorded yet" />
            : <div style={{ borderTop: `1px solid ${T.line}` }}>
              {history.data.map((a) => (
                <div key={a.attendance_id} className="row" style={{ padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                    <M style={{ fontSize: 11, color: T.faint, width: 48, flexShrink: 0 }}>{istDateShort(a.work_date)}</M>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Type, place and zone as the server recorded them. */}
                      <div style={{ fontSize: 13 }}>
                        {a.location_type === 'SCHOOL' ? 'School' : a.location_type === 'OFFICE' ? 'Office' : (a.role === 'Trainer' || a.role === 'Technical Support') ? 'Field' : '—'}
                        {a.site_name ? ` · ${a.site_name}` : ''}
                      </div>
                      {a.site_zone && (
                        <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 3 }}>{a.site_zone}</M>
                      )}
                    </div>
                    <Status state={a.status} />
                  </div>
                  <M style={{ fontSize: 11, color: T.mute, display: 'block', marginTop: 6, paddingLeft: 60 }}>
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

function EContributions() {
  const T = useT();
  const api = useApi();
  const data = useResource(() => api.myContributions(), []);
  const [adding, setAdding] = useState(false);

  const items = data.data?.items || [];
  const replies = data.data?.replies || [];
  const replyMap = new Map();
  replies.forEach((r) => replyMap.set(r.contribution_id, [...(replyMap.get(r.contribution_id) || []), r]));

  return (
    <div style={{ padding: '32px 24px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 28 }}>
        <div><h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Contributions / Inconveniences</h1><div style={{ fontSize: 12, color: T.mute, marginTop: 6 }}>Additional contributions and inconveniences for the company.</div></div>
        <Btn onClick={() => setAdding(true)}>Add</Btn>
      </div>
      {data.loading ? <Rows n={4} />
        : data.error ? <ErrorBlock error={data.error} onRetry={data.reload} />
          : !items.length ? <Blank title="Nothing submitted yet" />
            : <div style={{ borderTop: `1px solid ${T.line}` }}>
              {items.map((x) => {
                const rs = replyMap.get(x.contribution_id) || [];
                return <div key={x.contribution_id} style={{ padding: '15px 0', borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0 }}><M style={{ fontSize: 10, color: T.faint }}>{String(x.work_date).slice(0,10)}</M><div style={{ fontSize: 14, fontWeight: 500, marginTop: 5 }}>{x.title}</div><div style={{ fontSize: 12, color: T.mute, marginTop: 4 }}>{x.entry_type}</div></div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}><Status state={x.status === 'Replied' ? 'Completed' : 'Pending'} /></div>
                  </div>
                  <div style={{ fontSize: 12, color: T.mute, lineHeight: 1.55, marginTop: 9 }}>{x.description}</div>
                  {rs.map((r) => <div key={r.reply_id} style={{ marginTop: 10, padding: '10px 12px', borderLeft: `2px solid ${T.line}`, background: T.sub }}><div style={{ fontSize: 10, color: T.faint }}>{r.author_name} · {istTime(r.created_at)}</div><div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{r.message}</div></div>)}
                </div>;
              })}
            </div>}
      {adding && <ContributionForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); data.reload(); }} />}
      <div style={{ height: 40 }} />
    </div>
  );
}

function ContributionForm({ onClose, onDone }) {
  const T = useT();
  const api = useApi();
  const key = useRef(newActionKey());
  const [entryType, setEntryType] = useState('Contribution');
  const [workDate, setWorkDate] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const incomplete = !workDate || !title.trim() || !description.trim();
  const submit = async () => {
    setBusy(true); setProblem(null);
    try {
      await api.createContribution({ workDate, entryType, title: title.trim(), description: description.trim() }, key.current);
      onDone();
    } catch (e) { setProblem(e); } finally { setBusy(false); }
  };
  return <div className="fade" style={{ position:'fixed', inset:0, background:T.overlay, display:'flex', alignItems:'flex-end', justifyContent:'center', zIndex:50 }}><div className="rise" style={{ width:'100%', maxWidth:420, background:T.bg, padding:28, borderTop:`1px solid ${T.line}`, maxHeight:'92vh', overflowY:'auto' }}>
    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:24 }}><div className="tight" style={{fontSize:18,fontWeight:600}}>New contribution / inconvenience</div><button className="press" onClick={onClose} style={{background:'none',border:'none',color:T.faint,cursor:'pointer',fontSize:16}}>×</button></div>
    <Field label="Type"><div style={{display:'flex',gap:8}}>{['Contribution','Inconvenience'].map((x)=><button key={x} className="press" onClick={()=>setEntryType(x)} style={{flex:1,padding:'10px 4px',borderRadius:8,border:`1px solid ${entryType===x?T.text:T.line}`,background:entryType===x?T.text:'transparent',color:entryType===x?T.bg:T.mute,fontSize:12}}>{x}</button>)}</div></Field>
    <Field label="Date"><Input type="date" value={workDate} max={new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})} onChange={e=>setWorkDate(e.target.value)} /></Field>
    <Field label="Title"><Input value={title} onChange={e=>setTitle(e.target.value)} placeholder={entryType==='Inconvenience'?'Describe the inconvenience':'Describe the contribution'} /></Field>
    <Field label="Details"><textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="Explain the additional contribution or inconvenience" rows={4} style={{width:'100%',padding:12,border:`1px solid ${T.line}`,borderRadius:8,background:T.bg,color:T.text,resize:'vertical',fontSize:14}} /></Field>

    {problem && <div style={{fontSize:13,color:T.accent,marginBottom:18}}>{problem.message}</div>}
    <div style={{display:'flex',gap:8}}><Btn variant="line" full onClick={onClose}>Cancel</Btn><Btn variant="accent" full busy={busy} disabled={incomplete} onClick={submit}>Submit</Btn></div>
  </div></div>;
}

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
              {pending > 0 && <div style={{ fontSize: 12, color: T.accent, marginTop: 10 }}>{rupees(pending)} in the current weekly review</div>}
            </div>

            <Eyebrow>History</Eyebrow>
            {!claims.data.length ? <Blank title="No claims yet" hint="Add the expense details; a bill is optional." />
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
  const [expenseType, setExpenseType] = useState('Local');
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
      const uploaded = file ? await api.uploadFile(file) : null;
      await api.createClaim({
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
        expenseType, category, amount: Number(amount),
        ...(uploaded?.attachment_id ? { attachmentId: uploaded.attachment_id } : {}),
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

  const incomplete = !expenseType || !amount || Number(amount) <= 0
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

        <Field label="Expense Type">
          <div style={{ display: 'flex', gap: 8 }}>
            {['Local', 'Outstation'].map((type) => (
              <button key={type} className="press" onClick={() => { setExpenseType(type); setProblem(null); }} style={{
                flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                background: expenseType === type ? T.text : 'transparent',
                color: expenseType === type ? T.bg : T.mute,
                border: `1px solid ${expenseType === type ? T.text : T.line}`,
                fontWeight: expenseType === type ? 500 : 400,
              }}>{type}</button>
            ))}
          </div>
        </Field>

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

        <Field label="Bill (Optional)">
          <label className="press" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', borderRadius: 8, border: `1px dashed ${file ? T.line : T.accent}`, color: file ? T.text : T.mute, cursor: 'pointer', fontSize: 14 }}>
            {file ? file.name : 'Upload bill (optional)'}
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [employeeDashboardId, setEmployeeDashboardId] = useState(null);
  const nav = [['dashboard', 'Today'], ['attendance', 'Attendance'], ['tasks', 'Daily Work'], ['schools', 'Schools'], ['news', 'Notices'], ['words', 'LAT'], ['claims', 'Claims'], ['contributions', 'Contributions'], ['employees', 'Team'], ['audit', 'Audit'], ['tools', 'Tools']];

  const body = (
    <main key={page} className="rise" style={{
      flex: 1, minWidth: 0,
      padding: isPhone ? '24px 20px 32px' : '48px 48px',
      maxWidth: isPhone ? '100%' : 1100,
    }}>
      {page === 'dashboard' && !employeeDashboardId && <ADash isPhone={isPhone} onEmployee={(id) => setEmployeeDashboardId(id)} />}
      {page === 'dashboard' && employeeDashboardId && <EmployeeDashboard employeeId={employeeDashboardId} isPhone={isPhone} onBack={() => setEmployeeDashboardId(null)} />}
      {page === 'attendance' && <AAttendance isPhone={isPhone} />}
      {page === 'tasks' && <ATasks isPhone={isPhone} />}
      {page === 'schools' && <ASchools isPhone={isPhone} />}
      {page === 'news' && <ANews isPhone={isPhone} />}
      {page === 'words' && <AWords isPhone={isPhone} />}
      {page === 'claims' && <AClaims isPhone={isPhone} />}
      {page === 'contributions' && <AContributions isPhone={isPhone} />}
      {page === 'employees' && <AEmployees isPhone={isPhone} />}
      {page === 'audit' && <AAudit />}
      {page === 'tools' && <ATools isPhone={isPhone} />}
    </main>
  );

  // On phones the navigation is an off-canvas sidebar so content keeps the full viewport width.
  if (isPhone) {
    return (
      <div style={{ minHeight: '100vh', maxWidth: '100%', overflowX: 'hidden' }}>
        <header style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', borderBottom: `1px solid ${T.line}`,
          position: 'sticky', top: 0, background: T.bg, zIndex: 20,
        }}>
          <button
            className="press"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
            style={{
              background: 'none',
              border: 'none',
              color: T.text,
              fontSize: 22,
              cursor: 'pointer',
              padding: 4,
              lineHeight: 1,
            }}
          >
            ☰
          </button>

          <Brand size={22} showName={false} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </header>

        {body}

        {sidebarOpen && (
          <>
            <div
              onClick={() => setSidebarOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,.45)',
                zIndex: 40,
              }}
            />

            <aside
              className="rise"
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                bottom: 0,
                width: '82%',
                maxWidth: 320,
                background: T.bg,
                borderRight: `1px solid ${T.line}`,
                zIndex: 50,
                padding: '24px 24px',
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
              }}
            >
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 32,
              }}>
                <Brand size={24} />

                <button
                  className="press"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close navigation"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: T.mute,
                    fontSize: 24,
                    cursor: 'pointer',
                    padding: 4,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ display: 'grid', gap: 4 }}>
                {nav.map(([k, label]) => (
                  <button
                    key={k}
                    className="press"
                    onClick={() => {
                      setPage(k);
                      setSidebarOpen(false);
                    }}
                    style={{
                      width: '100%',
                      background: page === k ? T.sub : 'transparent',
                      border: 'none',
                      borderRadius: 8,
                      textAlign: 'left',
                      padding: '13px 12px',
                      cursor: 'pointer',
                      fontSize: 15,
                      color: page === k ? T.text : T.mute,
                      fontWeight: page === k ? 500 : 400,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div style={{
                marginTop: 'auto',
                paddingTop: 20,
                borderTop: `1px solid ${T.line}`,
              }}>
                <div style={{
                  fontSize: 12,
                  color: T.mute,
                  marginBottom: 8,
                }}>
                  {me.name}
                </div>

                <ThemeToggle theme={theme} setTheme={setTheme} />

                <button
                  className="press"
                  onClick={async () => {
                    try {
                      await api.logout();
                    } finally {
                      setSidebarOpen(false);
                      onOut();
                    }
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    background: 'none',
                    border: 'none',
                    color: T.mute,
                    fontSize: 13,
                    cursor: 'pointer',
                    padding: '12px 8px',
                    textAlign: 'left',
                  }}
                >
                  Sign out
                </button>
              </div>
            </aside>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: 210, flexShrink: 0, borderRight: `1px solid ${T.line}`, padding: '28px 20px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 36 }}><Brand size={24} /></div>
        {nav.map(([k, label]) => (
          <button key={k} className="press" onClick={() => { setEmployeeDashboardId(null); setPage(k); }} style={{
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

function ADash({ isPhone, onEmployee }) {
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
          <button key={b.employee_id} className="row press" onClick={() => onEmployee?.(b.employee_id)} style={{ width: '100%', textAlign: 'left', padding: '14px 0', border: 'none', borderBottom: `1px solid ${T.line}`, background: 'none', color: T.text, cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{b.name}</div>
                <div style={{ fontSize: 12, color: T.mute, marginTop: 2 }}>{b.role}</div>
              </div>
              <Status state={b.attendance_status} />
              <span style={{ color: T.faint, fontSize: 18 }}>›</span>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
              <M style={{ fontSize: 12, color: T.mute }}>{b.completed}/{b.tasks_assigned} done</M>
              {Number(b.overdue) > 0 && <M style={{ fontSize: 12, color: T.accent }}>{b.overdue} overdue</M>}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}


function EmployeeDashboard({ employeeId, isPhone, onBack }) {
  const T = useT();
  const api = useApi();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const monthStart = `${today.slice(0, 7)}-01`;
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const report = useResource(() => api.admin.employeeDashboard(employeeId, from, to), [employeeId, from, to]);
  const [detail, setDetail] = useState(null);

  const quick = (kind) => {
    if (kind === 'today') { setFrom(today); setTo(today); return; }
    if (kind === 'week') {
      const d = new Date(`${today}T00:00:00Z`);
      const dow = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
      setFrom(d.toISOString().slice(0, 10)); setTo(today); return;
    }
    setFrom(monthStart); setTo(today);
  };
  const fmtHours = (h) => `${Math.floor(Number(h || 0))}h ${Math.round((Number(h || 0) % 1) * 60)}m`;
  const fmtMoney = (p) => rupees(p);
  const dateText = (d) => d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
  const timeText = (d) => d ? istTime(d) : '—';
  const dayKey = (d) => String(d || '').slice(0, 10);

  if (report.loading) return <><button onClick={onBack} style={{ background: 'none', border: 'none', color: T.mute, padding: 0, marginBottom: 20, cursor: 'pointer' }}>← Back</button><h1 className="tight" style={{ fontSize: 24, fontWeight: 600 }}>Employee Dashboard</h1><div style={{ height: 32 }} /><Rows n={6} /></>;
  if (report.error) return <><button onClick={onBack} style={{ background: 'none', border: 'none', color: T.mute, padding: 0, marginBottom: 20, cursor: 'pointer' }}>← Back</button><ErrorBlock error={report.error} onRetry={report.reload} /></>;

  const { employee, summary, attendance, schoolVisits, tasks, claims, contributions, contributionReplies, workDone = [], latAttempts } = report.data;
  const attMap = new Map(attendance.map((a) => [dayKey(a.work_date), a]));
  const visitsByDay = new Map();
  schoolVisits.forEach((v) => { const k = dayKey(v.work_date); visitsByDay.set(k, [...(visitsByDay.get(k) || []), v]); });
  const claimsByDay = new Map();
  claims.forEach((c) => { const k = dayKey(c.claim_date); claimsByDay.set(k, [...(claimsByDay.get(k) || []), c]); });
  const taskByDay = new Map();
  tasks.forEach((t) => { const k = dayKey(t.due_date); taskByDay.set(k, [...(taskByDay.get(k) || []), t]); });
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = [];
  for (let d = new Date(end); d >= start; d.setUTCDate(d.getUTCDate() - 1)) days.push(d.toISOString().slice(0, 10));

  const card = (label, value, sub) => (
    <div style={{ padding: 16, border: `1px solid ${T.line}`, borderRadius: 10, background: T.sub, minWidth: 0 }}>
      <div className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.12em', color: T.faint, marginBottom: 8 }}>{label}</div>
      <div className="tight" style={{ fontSize: isPhone ? 22 : 28, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: T.mute, marginTop: 5 }}>{sub}</div>}
    </div>
  );

  return (
    <>
      <button className="press" onClick={onBack} style={{ background: 'none', border: 'none', color: T.mute, padding: 0, marginBottom: 18, cursor: 'pointer', fontSize: 13 }}>← Back to dashboard</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>{employee.name}</h1>
          <div style={{ fontSize: 12, color: T.mute, marginTop: 6 }}>{employee.role} · {employee.employee_code}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['today', 'week', 'month'].map((k) => <button key={k} className="press" onClick={() => quick(k)} style={{ padding: '8px 11px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.bg, color: T.text, fontSize: 12 }}>{k === 'today' ? 'Today' : k === 'week' ? 'This Week' : 'This Month'}</button>)}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr 1fr' : '1fr 1fr', gap: 10, marginBottom: 28 }}>
        <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(4,1fr)', gap: 12, marginBottom: 12 }}>
        {card('Attendance', `${summary.attendanceDays} days`, `${summary.completedDays} completed · ${summary.lateDays} late`)}
        {card('Working Time', fmtHours(summary.totalHours), `${summary.fieldDays} field days`)}
        {card('School Visits', summary.schoolVisits, fmtHours(summary.visitHours))}
        {card('Tasks', `${summary.tasksCompleted}/${summary.tasksAssigned}`, `${summary.tasksOverdue} overdue · ${summary.tasksSubmitted} submitted`)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        {card('Claims', fmtMoney(summary.claimsTotal), `${summary.claimCount} claims`)}
        <button className="press" onClick={() => setDetail(detail === 'contributions' ? null : 'contributions')} style={{ padding: 0, border: 0, textAlign: 'left', background: 'none', color: T.text, cursor: 'pointer' }} aria-label="View Contributions / Inconveniences">
          {card('Contributions / Inconveniences', summary.contributionsCount || 0, `${summary.contributionsCount || 0} entries · click to view`)}
        </button>
        <button className="press" onClick={() => setDetail(detail === 'workdone' ? null : 'workdone')} style={{ padding: 0, border: 0, textAlign: 'left', background: 'none', color: T.text, cursor: 'pointer' }} aria-label="View Work Done">
          {card('Work Done', summary.tasksAssigned || 0, `${summary.tasksCompleted || 0} completed · ${Math.max(0, (summary.tasksAssigned || 0) - (summary.tasksCompleted || 0))} pending · click to view`)}
        </button>
        {card('LAT', summary.latCompleted ? `${summary.latScore}/${summary.latPossible}` : '—', `${summary.latCompleted}/${summary.latAttempts} completed`)}
      </div>

      {detail === 'contributions' && (
        <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, marginBottom: 28, background: T.sub }}>
          <div style={{ marginBottom: 12 }}><Eyebrow>Contributions / Inconveniences</Eyebrow><div style={{ fontSize: 12, color: T.mute, marginTop: -4 }}>Contributions and inconveniences, shown day by day.</div></div>
          {(() => {
            const byDay = new Map();
            (contributions || []).forEach((x) => { const k = dayKey(x.work_date); byDay.set(k, [...(byDay.get(k) || []), x]); });
            const rows = Array.from(byDay.entries()).sort((a,b) => b[0].localeCompare(a[0]));
            const replies = contributionReplies || [];
            return rows.length ? rows.map(([day, items]) => (
              <div key={day} style={{ padding: '11px 0', borderTop: `1px solid ${T.line}` }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 7 }}>{dateText(day)} · {items.length} entries</div>
                {items.map((x) => <div key={x.contribution_id} style={{ padding: '8px 0' }}><div style={{ display:'flex',justifyContent:'space-between',gap:10 }}><span style={{fontSize:12,fontWeight:500}}>{x.title}</span></div><div style={{fontSize:11,color:T.mute,marginTop:3}}>{x.entry_type} · {x.status}</div><div style={{fontSize:11,color:T.mute,marginTop:3,lineHeight:1.45}}>{x.description}</div>{replies.filter(r=>r.contribution_id===x.contribution_id).map(r=><div key={r.reply_id} style={{marginTop:6,padding:'7px 9px',borderLeft:`2px solid ${T.line}`}}><div style={{fontSize:10,color:T.faint}}>{r.author_name}</div><div style={{fontSize:11}}>{r.message}</div></div>)}</div>)}
              </div>
            )) : <div style={{ fontSize: 12, color: T.mute, paddingTop: 4 }}>No contributions / inconveniences in this period.</div>;
          })()}
        </div>
      )}

      {detail === 'workdone' && (
        <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, marginBottom: 28, background: T.sub }}>
          <div style={{ marginBottom: 12 }}>
            <Eyebrow>Work Done</Eyebrow>
            <div style={{ fontSize: 12, color: T.mute, marginTop: -4 }}>All assigned work, shown day by day. Completed items are marked done; unfinished items carry forward to the next day.</div>
          </div>
          {(() => {
            const byDay = new Map();
            (tasks || []).forEach((t) => { const k = dayKey(t.due_date); byDay.set(k, [...(byDay.get(k) || []), t]); });
            (workDone || []).forEach((w) => { const k = dayKey(w.work_date); byDay.set(k, [...(byDay.get(k) || []), { ...w, _manual: true }]); });
            const rows = Array.from(byDay.entries()).sort((a,b) => b[0].localeCompare(a[0]));
            return rows.length ? rows.map(([day, items]) => (
              <div key={day} style={{ padding: '11px 0', borderTop: `1px solid ${T.line}` }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 7 }}>{dateText(day)} · {items.length} items</div>
                <div style={{ display: 'grid', gap: 7 }}>
                  {items.map((t, i) => t._manual ? (
                    <div key={`manual-${t.work_done_id || i}`} style={{ fontSize: 11, color: T.mute }}><span style={{ color: T.text }}>Work note</span> · {t.summary || t.description || t.work_text || '—'}</div>
                  ) : (
                    <div key={t.task_id} style={{ display:'flex',justifyContent:'space-between',gap:10,fontSize:11 }}><span style={{ color: T.text }}>{t.title}</span><span style={{ color: t.effective_status === 'Completed' ? T.text : T.faint }}>{t.effective_status === 'Completed' ? 'Completed' : 'Pending'}</span></div>
                  ))}
                </div>
              </div>
            )) : <div style={{ fontSize: 12, color: T.mute, paddingTop: 4 }}>No work assigned or recorded in this period.</div>;
          })()}
        </div>
      )}

      <Eyebrow>Daily Summary</Eyebrow>
      <div style={{ borderTop: `1px solid ${T.line}`, marginBottom: 36 }}>
        {days.map((day) => {
          const a = attMap.get(day);
          const vs = visitsByDay.get(day) || [];
          const cs = claimsByDay.get(day) || [];
          const ts = taskByDay.get(day) || [];
          const dayHours = a?.check_in_time && a?.check_out_time ? ((new Date(a.check_out_time) - new Date(a.check_in_time)) / 3600000) : 0;
          const claimAmount = cs.reduce((sum, c) => sum + Number(c.amount_paise || 0), 0);
          return <div key={day} style={{ padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <div style={{ width: 70, fontSize: 13, fontWeight: 500 }}>{dateText(day)}</div>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: T.mute }}>
                {a ? `${a.status || 'Present'} · ${timeText(a.check_in_time)}–${timeText(a.check_out_time)}` : 'No attendance'}
              </div>
              <M style={{ fontSize: 12 }}>{dayHours ? fmtHours(dayHours) : '—'}</M>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 7, marginLeft: 82, fontSize: 11, color: T.mute }}>
              {vs.length > 0 && <span>{vs.length} school visit{vs.length > 1 ? 's' : ''}</span>}
              {ts.length > 0 && <span>{ts.filter((t) => t.effective_status === 'Completed').length}/{ts.length} tasks done</span>}
              {cs.length > 0 && <span>{cs.length} claim{cs.length > 1 ? 's' : ''} · {fmtMoney(claimAmount)}</span>}
              {a?.check_in_site && <span>{a.check_in_site}</span>}
            </div>
          </div>;
        })}
      </div>

      <Eyebrow>School Visits</Eyebrow>
      {!schoolVisits.length ? <Blank title="No school visits in this period" /> : <div style={{ borderTop: `1px solid ${T.line}`, marginBottom: 36 }}>
        {schoolVisits.map((v) => <div key={v.visit_id} style={{ padding: '13px 0', borderBottom: `1px solid ${T.line}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 13, fontWeight: 500 }}>{v.school_name}</span><M style={{ fontSize: 11, color: T.faint }}>{dateText(v.work_date)}</M></div>
          <M style={{ fontSize: 11, color: T.mute, display: 'block', marginTop: 5 }}>{timeText(v.check_in_time)} – {timeText(v.check_out_time)}</M>
        </div>)}
      </div>}

      <Eyebrow>Claims</Eyebrow>
      {!claims.length ? <Blank title="No claims in this period" /> : <div style={{ borderTop: `1px solid ${T.line}`, marginBottom: 36 }}>
        {claims.map((c) => <div key={c.claim_id} style={{ padding: '12px 0', borderBottom: `1px solid ${T.line}`, display: 'flex', gap: 12 }}><div style={{ flex: 1 }}><div style={{ fontSize: 13 }}>{c.category} · {c.expense_type}</div><div style={{ fontSize: 11, color: T.mute, marginTop: 4 }}>{dateText(c.claim_date)}{c.place ? ` · ${c.place}` : ''}</div></div><M style={{ fontSize: 13 }}>{fmtMoney(c.amount_paise)}</M></div>)}
      </div>}
    </>
  );
}

function ASchools({ isPhone }) {
  const T = useT();
  const api = useApi();
  return <AdminSchools T={T} api={api} isPhone={isPhone} useResource={useResource}
    Btn={Btn} ErrorBlock={ErrorBlock} Rows={Rows} Blank={Blank} M={M} />;
}

/** Read-only view of who was where today. */
function AAttendance({ isPhone }) {
  const T = useT();
  const api = useApi();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [date, setDate] = useState(today);
  const rows = useResource(() => api.admin.attendance(date), [date]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 24 }}>
        <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Attendance</h1>
        <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)}
          className="mono" style={{
            padding: '8px 12px', borderRadius: 8, fontSize: 13, background: 'transparent',
            border: `1px solid ${T.line}`, color: T.text, outline: 'none',
          }} />
      </div>

      {rows.loading ? <Rows n={5} />
        : rows.error ? <ErrorBlock error={rows.error} onRetry={rows.reload} />
          : <div style={{ borderTop: `1px solid ${T.line}` }}>
            {rows.data.map((r) => (
              <div key={r.employee_id} style={{ padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{r.employee_name}</div>
                    <div style={{ fontSize: 12, color: T.mute, marginTop: 3 }}>
                      {r.check_in_time
                        ? `${r.location_type === 'SCHOOL' ? 'School' : r.location_type === 'OFFICE' ? 'Office' : (r.role === 'Trainer' || r.role === 'Technical Support') ? 'Field' : '—'} · ${r.site_name || ((r.role === 'Trainer' || r.role === 'Technical Support') ? 'Any location' : '—')}${r.site_zone ? ` · ${r.site_zone}` : ''}`
                        : r.role}
                    </div>
                    {r.attendance_sessions > 0 && <M style={{ fontSize: 10, color: T.faint, display: 'block', marginTop: 4 }}>
                      {r.attendance_sessions} session{r.attendance_sessions > 1 ? 's' : ''}{r.open_sessions ? ' · active now' : ''}
                    </M>}
                  </div>
                  <Status state={r.status || 'Absent'} />
                </div>
                {r.check_in_time && (
                  <M style={{ fontSize: 12, color: T.mute, display: 'block', marginTop: 8 }}>
                    {istTime(r.check_in_time)} – {r.check_out_time ? istTime(r.check_out_time) : 'still in'}
                    {r.check_in_accuracy ? ` · ±${r.check_in_accuracy} m` : ''}
                  </M>
                )}
              </div>
            ))}
          </div>}
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
  const [selectedCycle, setSelectedCycle] = useState(null);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [filter, setFilter] = useState('All');
  const [acting, setActing] = useState(null);
  const [claimTab, setClaimTab] = useState('weekly');
  const cycleInfo = useResource(() => api.admin.claimCycles(), []);

  // Step 3 uses the weekly cycle data already returned by the Step 2
  // /admin/claims endpoint. This keeps the screen compatible with the
  // existing api-client while making the accountant view employee-first.
  const claims = useResource(() => api.admin.claims(), []);
  const rows = claims.data || [];

  const cycles = Array.from(
    new Map(
      rows
        .filter((c) => c.cycle_start)
        .map((c) => [c.cycle_start, {
          cycle_start: c.cycle_start,
          cycle_end: c.cycle_end,
        }])
    ).values()
  ).sort((a, b) => String(b.cycle_start).localeCompare(String(a.cycle_start)));

  const activeCycle = selectedCycle || cycles[0]?.cycle_start || null;
  const activeCycleInfo = (cycleInfo.data || []).find((c) => c.cycle_start === activeCycle);
  const cycleClaims = rows.filter((c) => c.cycle_start === activeCycle);
  const cycleStatus = activeCycleInfo?.status || cycleClaims[0]?.cycle_status || 'Open';

  const money = (items) => items.reduce((sum, c) => sum + Number(c.amount_paise || 0), 0);

  const localTotal = money(cycleClaims.filter((c) => c.expense_type === 'Local'));
  const outstationTotal = money(cycleClaims.filter((c) => c.expense_type === 'Outstation'));
  const weeklyTotal = money(cycleClaims);

  const employeeMap = new Map();
  cycleClaims.forEach((c) => {
    const key = c.employee_id;
    if (!employeeMap.has(key)) {
      employeeMap.set(key, {
        employee_id: key,
        employee_name: c.employee_name || 'Unknown',
        local: 0,
        outstation: 0,
        total: 0,
        bill_count: 0,
      });
    }
    const e = employeeMap.get(key);
    const amount = Number(c.amount_paise || 0);
    e.total += amount;
    e.bill_count += 1;
    if (c.expense_type === 'Local') e.local += amount;
    if (c.expense_type === 'Outstation') e.outstation += amount;
  });

  const employees = Array.from(employeeMap.values()).sort((a, b) =>
    a.employee_name.localeCompare(b.employee_name)
  );

  const employeeClaims = selectedEmployee
    ? cycleClaims.filter((c) => c.employee_id === selectedEmployee.employee_id)
    : [];

  const visibleClaims = filter === 'All'
    ? employeeClaims
    : employeeClaims.filter((c) => c.expense_type === filter);

  const selectedEmployeeTotals = selectedEmployee
    ? {
        local: money(employeeClaims.filter((c) => c.expense_type === 'Local')),
        outstation: money(employeeClaims.filter((c) => c.expense_type === 'Outstation')),
        total: money(employeeClaims),
      }
    : null;

  const cycleLabel = (start, end) => {
    if (!start) return 'Weekly Claims';
    const toDateOnly = (value) => {
      const raw = String(value || '').slice(0, 10);
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      const [, y, m, d] = match;
      const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const s = toDateOnly(start);
    const e = toDateOnly(end || start);
    if (!s || !e) return 'Weekly Claims';
    const opts = { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' };
    return `${s.toLocaleDateString('en-IN', opts)}–${e.toLocaleDateString('en-IN', opts)}`;
  };

  const card = (label, value) => (
    <div style={{
      padding: 16, border: `1px solid ${T.line}`, borderRadius: 10,
      background: T.sub, minWidth: 0,
    }}>
      <div className="mono" style={{
        fontSize: 10, textTransform: 'uppercase', letterSpacing: '.12em',
        color: T.faint, marginBottom: 8,
      }}>{label}</div>
      <div className="tight" style={{ fontSize: 22, fontWeight: 600 }}>{rupees(value)}</div>
    </div>
  );

  const runCycleAction = async (action) => {
    if (!activeCycle || acting) return;
    setActing(action);
    try {
      const key = newActionKey();
      if (action === 'review') await api.admin.reviewClaimCycle(activeCycle, key);
      if (action === 'close') await api.admin.closeClaimCycle(activeCycle, key);
      await Promise.all([claims.reload(), cycleInfo.reload()]);
    } catch (e) {
      alert(e?.message || 'Could not update the claim cycle.');
    } finally {
      setActing(null);
    }
  };

  const exportCycle = async () => {
    if (!activeCycle || acting) return;
    setActing('export');
    try { await api.admin.exportClaims(activeCycle); }
    catch (e) { alert(e?.message || 'Could not export the claim cycle.'); }
    finally { setActing(null); }
  };

  const exportAndClearCycle = async (cycle) => {
    if (!cycle || acting) return;
    setActing(`clear:${cycle}`);
    try {
      await api.admin.exportClaims(cycle);
      const ok = window.confirm(`The Excel file for ${cycle} has been downloaded. Continue and permanently clear this exported week's claims and bill files?`);
      if (!ok) return;
      await api.admin.clearClaimCycle(cycle, newActionKey());
      await Promise.all([claims.reload(), cycleInfo.reload()]);
      if (selectedCycle === cycle) setSelectedCycle(null);
      alert('The exported week and its stored bill files have been cleared.');
    } catch (e) {
      alert(e?.message || 'Could not export and clear the claim cycle.');
    } finally { setActing(null); }
  };

  if (claimTab === 'clear') {
    const closedCycles = (cycleInfo.data || []).filter((c) => c.status === 'Closed');
    const cycleLabelFor = (c) => cycleLabel(c.cycle_start, c.cycle_end);
    return (
      <>
        <div style={{ display: 'flex', gap: 8, marginBottom: 28, borderBottom: `1px solid ${T.line}` }}>
          {['weekly', 'clear'].map((tab) => (
            <button key={tab} className="press" onClick={() => setClaimTab(tab)} style={{
              background: 'none', border: 'none', padding: '0 0 12px', marginRight: 16,
              color: claimTab === tab ? T.text : T.faint, cursor: 'pointer', fontSize: 13,
              borderBottom: claimTab === tab ? `1.5px solid ${T.accent}` : '1.5px solid transparent',
            }}>{tab === 'weekly' ? 'Weekly Claims' : 'Clear Exported Weeks'}</button>
          ))}
        </div>
        <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 8px' }}>Clear exported weeks</h1>
        <p style={{ fontSize: 13, color: T.mute, lineHeight: 1.6, margin: '0 0 28px', maxWidth: 680 }}>
          Export a closed Saturday–Friday cycle first. The action below downloads the Excel file and then asks for confirmation before permanently deleting that week's claim rows and stored bill files.
        </p>
        {!closedCycles.length ? <Blank title="No closed weeks to clear" /> : (
          <div style={{ borderTop: `1px solid ${T.line}` }}>
            {closedCycles.map((c) => (
              <div key={c.cycle_start} style={{ padding: '16px 0', borderBottom: `1px solid ${T.line}`, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{cycleLabelFor(c)}</div>
                  <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 5 }}>{c.bill_count} expense entries · {rupees(c.total_paise)}</M>
                </div>
                <button className="press" disabled={!!acting} onClick={() => exportAndClearCycle(c.cycle_start)} style={{
                  padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.bg,
                  color: T.text, cursor: acting ? 'wait' : 'pointer',
                }}>{acting === `clear:${c.cycle_start}` ? 'Exporting & clearing…' : 'Export & Clear'}</button>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // Weekly claims tab
  const claimTabs = (
    <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: `1px solid ${T.line}` }}>
      {['weekly', 'clear'].map((tab) => (
        <button key={tab} className="press" onClick={() => { setClaimTab(tab); setSelectedEmployee(null); }} style={{
          background: 'none', border: 'none', padding: '0 0 12px', marginRight: 16,
          color: claimTab === tab ? T.text : T.faint, cursor: 'pointer', fontSize: 13,
          borderBottom: claimTab === tab ? `1.5px solid ${T.accent}` : '1.5px solid transparent',
        }}>{tab === 'weekly' ? 'Weekly Claims' : 'Clear Exported Weeks'}</button>
      ))}
    </div>
  );

  if (selectedEmployee) {
    return (
      <>
        <BackLink onBack={() => { setSelectedEmployee(null); setFilter('All'); }} />
        <div style={{ marginBottom: 28 }}>
          <div className="mono" style={{ fontSize: 11, color: T.faint, marginBottom: 8 }}>
            {activeCycle ? cycleLabel(activeCycle, cycles.find((c) => c.cycle_start === activeCycle)?.cycle_end) : 'Weekly Claims'}
          </div>
          <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>
            {selectedEmployee.employee_name}
          </h1>
          <div style={{ fontSize: 12, color: T.mute, marginTop: 6 }}>
            {employeeClaims.length} expense {employeeClaims.length === 1 ? 'entry' : 'entries'}
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(3, 1fr)',
          gap: 12, marginBottom: 32,
        }}>
          {card('Local', selectedEmployeeTotals.local)}
          {card('Outstation', selectedEmployeeTotals.outstation)}
          {card('Total', selectedEmployeeTotals.total)}
        </div>

        <Eyebrow>Expenses</Eyebrow>
        <div style={{
          display: 'flex', gap: 8, borderBottom: `1px solid ${T.line}`, marginBottom: 8,
        }}>
          {['All', 'Local', 'Outstation'].map((k) => (
            <button key={k} className="press" onClick={() => setFilter(k)} style={{
              background: 'none', border: 'none', padding: '0 0 12px',
              cursor: 'pointer', fontSize: 12,
              color: filter === k ? T.text : T.faint,
              fontWeight: filter === k ? 500 : 400,
              borderBottom: filter === k ? `1.5px solid ${T.accent}` : '1.5px solid transparent',
            }}>{k}</button>
          ))}
        </div>

        {!visibleClaims.length
          ? <Blank title={`No ${filter === 'All' ? '' : filter + ' '}expenses`} />
          : (
            <div style={{ borderTop: `1px solid ${T.line}` }}>
              {visibleClaims.map((c) => (
                <div key={c.claim_id} style={{
                  display: 'flex', gap: 14, padding: '16px 0',
                  borderBottom: `1px solid ${T.line}`, alignItems: 'flex-start',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{c.category}</div>
                      <span style={{
                        fontSize: 10, padding: '3px 7px', borderRadius: 999,
                        border: `1px solid ${T.line}`, color: T.mute,
                      }}>{c.expense_type || 'Unclassified'}</span>
                    </div>
                    <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 5 }}>
                      {istDateShort(c.claim_date)}
                    </M>
                    {(c.place || c.location || c.note) && (
                      <div style={{ fontSize: 12, color: T.mute, marginTop: 5 }}>
                        {c.place || c.location || c.note}
                      </div>
                    )}
                  </div>
                  <M style={{ fontSize: 14, fontWeight: 500 }}>{rupees(c.amount_paise)}</M>
                </div>
              ))}
            </div>
          )}
      </>
    );
  }

  return (
    <>
      {claimTabs}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 16, marginBottom: 24, flexWrap: 'wrap',
      }}>
        <div>
          <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Claims</h1>
          {activeCycle && (
            <div style={{ fontSize: 12, color: T.mute, marginTop: 7 }}>
              {cycleLabel(activeCycle, cycles.find((c) => c.cycle_start === activeCycle)?.cycle_end)}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: isPhone ? 'flex-start' : 'flex-end' }}>
          {cycles.length > 0 && (
            <select value={activeCycle || ''} onChange={(e) => { setSelectedCycle(e.target.value || null); setSelectedEmployee(null); setFilter('All'); }}
              style={{
                padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.line}`,
                background: T.bg, color: T.text, fontSize: 13, maxWidth: isPhone ? '100%' : 230,
              }}>
              {cycles.map((c) => (
                <option key={c.cycle_start} value={c.cycle_start}>
                  {cycleLabel(c.cycle_start, c.cycle_end)}
                </option>
              ))}
            </select>
          )}
          {activeCycle && <span style={{ fontSize: 11, padding: '7px 9px', border: `1px solid ${T.line}`, borderRadius: 999, color: T.mute }}>{cycleStatus}</span>}
          {activeCycle && cycleStatus === 'Open' && (
            <button className="press" disabled={!!acting} onClick={() => runCycleAction('review')} style={{ padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.sub, color: T.text, cursor: acting ? 'wait' : 'pointer' }}>
              {acting === 'review' ? 'Reviewing…' : 'Mark Reviewed'}
            </button>
          )}
          {activeCycle && cycleStatus === 'Reviewed' && (
            <button className="press" disabled={!!acting} onClick={() => runCycleAction('close')} style={{ padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.text, color: T.bg, cursor: acting ? 'wait' : 'pointer' }}>
              {acting === 'close' ? 'Closing…' : 'Close Cycle'}
            </button>
          )}
          {activeCycle && (
            <button className="press" disabled={!!acting} onClick={exportCycle} style={{ padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.bg, color: T.text, cursor: acting ? 'wait' : 'pointer' }}>
              {acting === 'export' ? 'Exporting…' : 'Export Excel'}
            </button>
          )}
        </div>
      </div>

      {claims.loading ? <Rows n={5} />
        : claims.error ? <ErrorBlock error={claims.error} onRetry={claims.reload} />
          : !activeCycle ? <Blank title="No claim cycles yet" hint="Weekly claims will appear here once expenses are submitted." />
          : (
            <>
              <div style={{
                display: 'grid',
                gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(4, 1fr)',
                gap: 12, marginBottom: 36,
              }}>
                {card('Weekly Total', weeklyTotal)}
                {card('Local', localTotal)}
                {card('Outstation', outstationTotal)}
                <div style={{
                  padding: 16, border: `1px solid ${T.line}`, borderRadius: 10,
                  background: T.sub, minWidth: 0,
                }}>
                  <div className="mono" style={{
                    fontSize: 10, textTransform: 'uppercase', letterSpacing: '.12em',
                    color: T.faint, marginBottom: 8,
                  }}>Employees</div>
                  <div className="tight" style={{ fontSize: 22, fontWeight: 600 }}>{employees.length}</div>
                  <div style={{ fontSize: 11, color: T.mute, marginTop: 4 }}>
                    {cycleClaims.length} expense {cycleClaims.length === 1 ? 'entry' : 'entries'}
                  </div>
                </div>
              </div>

              <Eyebrow>Employees</Eyebrow>
              {!employees.length ? <Blank title="No claims in this cycle" />
                : (
                  <div style={{ borderTop: `1px solid ${T.line}` }}>
                    {employees.map((e) => (
                      <button key={e.employee_id} className="row press"
                        onClick={() => setSelectedEmployee(e)}
                        style={{
                          width: '100%', display: 'flex', gap: 16, alignItems: 'center',
                          textAlign: 'left', padding: '16px 0', background: 'none',
                          border: 'none', borderBottom: `1px solid ${T.line}`,
                          cursor: 'pointer', color: T.text,
                        }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{e.employee_name}</div>
                          <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 5 }}>
                            {e.bill_count} expense {e.bill_count === 1 ? 'entry' : 'entries'}
                          </M>
                        </div>
                        <div style={{ textAlign: 'right', minWidth: isPhone ? 92 : 240 }}>
                          {!isPhone && (
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, marginBottom: 4 }}>
                              <M style={{ fontSize: 11, color: T.mute }}>Local {rupees(e.local)}</M>
                              <M style={{ fontSize: 11, color: T.mute }}>Out {rupees(e.outstation)}</M>
                            </div>
                          )}
                          <M style={{ fontSize: 14, fontWeight: 500 }}>{rupees(e.total)}</M>
                        </div>
                        <span style={{ color: T.faint, fontSize: 18 }} aria-hidden="true">›</span>
                      </button>
                    ))}
                  </div>
                )}
            </>
          )}
    </>
  );
}


function AContributions({ isPhone }) {
  const T = useT();
  const api = useApi();
  const data = useResource(() => api.admin.contributions(), []);
  const [filter, setFilter] = useState('All');
  const [replyFor, setReplyFor] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const items = data.data?.items || [];
  const replies = data.data?.replies || [];
  const visible = items.filter((x) => filter === 'All' || (filter === 'Open' ? x.status === 'Open' : x.status === 'Replied'));
  const replyMap = new Map();
  replies.forEach((r) => replyMap.set(r.contribution_id, [...(replyMap.get(r.contribution_id) || []), r]));
  const sendReply = async () => {
    if (!replyFor || !reply.trim() || busy) return;
    setBusy(true);
    try { await api.admin.replyContribution(replyFor, { message: reply.trim() }, newActionKey()); setReply(''); setReplyFor(null); data.reload(); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };
  return <>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:16,marginBottom:24}}><div><h1 className="tight" style={{fontSize:24,fontWeight:600,margin:0}}>Contributions / Inconveniences</h1><div style={{fontSize:13,color:T.mute,marginTop:6}}>Additional contributions and inconveniences submitted by employees.</div></div></div>
    <div style={{display:'flex',gap:8,marginBottom:24}}>{['All','Open','Replied'].map(x=><button key={x} className="press" onClick={()=>setFilter(x)} style={{padding:'8px 12px',borderRadius:8,border:`1px solid ${filter===x?T.text:T.line}`,background:filter===x?T.text:'transparent',color:filter===x?T.bg:T.mute,fontSize:12}}>{x}</button>)}</div>
    {data.loading ? <Rows n={5} /> : data.error ? <ErrorBlock error={data.error} onRetry={data.reload} /> : !visible.length ? <Blank title="No entries" /> : <div style={{borderTop:`1px solid ${T.line}`}}>{visible.map(x=>{const rs=replyMap.get(x.contribution_id)||[]; return <div key={x.contribution_id} style={{padding:'16px 0',borderBottom:`1px solid ${T.line}`}}><div style={{display:'flex',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}><div><div style={{fontSize:14,fontWeight:500}}>{x.title}</div><M style={{fontSize:11,color:T.faint}}>{x.employee_name} · {String(x.work_date).slice(0,10)} · {x.entry_type}</M></div><div style={{textAlign:'right'}}><div style={{fontSize:11,color:T.mute,marginTop:4}}>{x.status}</div></div></div><div style={{fontSize:12,color:T.mute,lineHeight:1.55,marginTop:9}}>{x.description}</div>{rs.map(r=><div key={r.reply_id} style={{marginTop:10,padding:'9px 11px',borderLeft:`2px solid ${T.line}`,background:T.sub}}><div style={{fontSize:10,color:T.faint}}>{r.author_name}</div><div style={{fontSize:12,marginTop:3}}>{r.message}</div></div>)}<div style={{marginTop:11}}><Btn variant="line" onClick={()=>{setReplyFor(x.contribution_id);setReply('')}}>{rs.length?'Reply again':'Reply'}</Btn></div></div>})}</div>}
    {replyFor && <div className="fade" style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'flex-end',justifyContent:'center',zIndex:50}}><div className="rise" style={{width:'100%',maxWidth:520,background:T.bg,padding:24,borderTop:`1px solid ${T.line}`}}><div style={{display:'flex',justifyContent:'space-between',marginBottom:18}}><div className="tight" style={{fontSize:18,fontWeight:600}}>Reply to employee</div><button className="press" onClick={()=>setReplyFor(null)} style={{background:'none',border:'none',color:T.faint,fontSize:16}}>×</button></div><Field label="Reply"><textarea autoFocus rows={5} value={reply} onChange={e=>setReply(e.target.value)} placeholder="Write a clear response or acknowledgement…" style={{width:'100%',padding:12,border:`1px solid ${T.line}`,borderRadius:8,background:T.bg,color:T.text,resize:'vertical',fontSize:14}} /></Field><div style={{display:'flex',gap:8}}><Btn variant="line" full onClick={()=>setReplyFor(null)}>Cancel</Btn><Btn variant="accent" full busy={busy} disabled={!reply.trim()} onClick={sendReply}>Send Reply</Btn></div></div></div>}
  </>;
}

function ATools({ isPhone }) {
  const T = useT();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const reset = async () => {
    if (busy) return;
    if (!window.confirm('This will clear testing data, including claims, bill files, attendance, tasks, LAT attempts, notices and audit history. Employee accounts, schools and assignments are preserved. Continue?')) return;
    if (!window.confirm('FINAL CONFIRMATION: permanently RESET ALL TEST DATA?')) return;
    setBusy(true); setProblem(null);
    try {
      await api.admin.testReset(newActionKey());
      alert('Testing data has been cleared. Employee accounts and school configuration were preserved.');
    } catch (e) { setProblem(e); }
    finally { setBusy(false); }
  };
  return (
    <>
      <h1 className="tight" style={{fontSize:24,fontWeight:600,margin:'0 0 8px'}}>Admin Tools</h1>
      <p style={{fontSize:13,color:T.mute,lineHeight:1.6,margin:'0 0 28px',maxWidth:700}}>Use these tools only while testing. The reset is intentionally disabled unless the server has <M>ALLOW_TEST_RESET=true</M>. Remove that environment variable before production.</p>
      <div style={{border:`1px solid ${T.line}`,borderRadius:12,padding:20,background:T.sub,maxWidth:700}}>
        <div style={{fontSize:15,fontWeight:600,marginBottom:8}}>Reset testing data</div>
        <div style={{fontSize:13,color:T.mute,lineHeight:1.6,marginBottom:18}}>Clears operational test records and uploaded files, including claims, attendance, tasks, LAT data, notices and audit history. Employee accounts, school/location master data and trainer assignments remain.</div>
        {problem && <div style={{fontSize:13,color:T.accent,marginBottom:16}}>{problem.message}</div>}
        <button className="press" disabled={busy} onClick={reset} style={{padding:'10px 14px',borderRadius:8,border:`1px solid ${T.accent}`,background:'transparent',color:T.accent,cursor:busy?'wait':'pointer'}}>{busy?'Resetting…':'Reset All Test Data'}</button>
      </div>
    </>
  );
}


function ATasks({ isPhone }) {
  const T = useT();
  const api = useApi();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const staff = useResource(() => api.admin.employees(), []);
  const [date, setDate] = useState(today);
  const [assignedTo, setAssignedTo] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [dueTime, setDueTime] = useState('18:00');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const rows = useResource(() => api.admin.tasks(date), [date]);

  const save = async () => {
    if (!assignedTo || !title.trim() || !date) return;
    setBusy(true); setProblem(null);
    try {
      await api.admin.createTask({ title: title.trim(), description: description.trim() || null, assignedTo, priority, dueDate: date, dueTime });
      setTitle(''); setDescription(''); setPriority('Medium'); setDueTime('18:00');
      await rows.reload();
    } catch (e) { setProblem(e); }
    finally { setBusy(false); }
  };

  return <>
    <div style={{ marginBottom: 28 }}>
      <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 7px' }}>Daily Work</h1>
      <div style={{ fontSize: 13, color: T.mute }}>Admin and CEO can assign work to an employee for a specific day.</div>
    </div>

    <div style={{ border: `1px solid ${T.line}`, borderRadius: 12, padding: 18, background: T.sub, marginBottom: 30 }}>
      <Eyebrow>Assign Work</Eyebrow>
      <div style={{ display:'grid', gridTemplateColumns:isPhone?'1fr':'1fr 1fr', gap:12 }}>
        <Field label="Employee"><select value={assignedTo} onChange={e=>setAssignedTo(e.target.value)} style={{width:'100%',padding:'11px 12px',borderRadius:8,border:`1px solid ${T.line}`,background:T.bg,color:T.text,fontSize:13}}><option value="">Select employee</option>{(staff.data||[]).filter(e=>e.status==='Active').map(e=><option key={e.employee_id} value={e.employee_id}>{e.name} · {e.role}</option>)}</select></Field>
        <Field label="Date"><Input type="date" value={date} onChange={e=>setDate(e.target.value)} /></Field>
      </div>
      <Field label="Work"><Input value={title} onChange={e=>setTitle(e.target.value)} placeholder="What needs to be done?" /></Field>
      <Field label="Details (Optional)"><textarea rows={3} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Add instructions, expected outcome or context…" style={{width:'100%',boxSizing:'border-box',padding:12,border:`1px solid ${T.line}`,borderRadius:8,background:T.bg,color:T.text,resize:'vertical',fontSize:13}} /></Field>
      <div style={{display:'grid',gridTemplateColumns:isPhone?'1fr 1fr':'1fr 1fr',gap:12}}>
        <Field label="Priority"><select value={priority} onChange={e=>setPriority(e.target.value)} style={{width:'100%',padding:'11px 12px',borderRadius:8,border:`1px solid ${T.line}`,background:T.bg,color:T.text,fontSize:13}}>{['Low','Medium','High','Urgent'].map(x=><option key={x}>{x}</option>)}</select></Field>
        <Field label="Expected by"><Input type="time" value={dueTime} onChange={e=>setDueTime(e.target.value)} /></Field>
      </div>
      {problem && <div style={{fontSize:13,color:T.accent,marginBottom:12}}>{problem.message}</div>}
      <Btn variant="solid" disabled={!assignedTo || !title.trim()} busy={busy} onClick={save}>Assign Work</Btn>
    </div>

    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:12,marginBottom:14}}><Eyebrow>Work Assigned for {istDateShort(date)}</Eyebrow><M style={{fontSize:11,color:T.faint}}>{rows.data?.length || 0} items</M></div>
    {rows.loading ? <Rows n={5} /> : rows.error ? <ErrorBlock error={rows.error} onRetry={rows.reload} /> : !rows.data?.length ? <Blank title="No work assigned for this date" /> : <div style={{borderTop:`1px solid ${T.line}`}}>{rows.data.map(t=><div key={t.task_id} style={{padding:'14px 0',borderBottom:`1px solid ${T.line}`}}><div style={{display:'flex',justifyContent:'space-between',gap:14}}><div><div style={{fontSize:14,fontWeight:500}}>{t.title}</div><M style={{fontSize:11,color:T.faint,display:'block',marginTop:5}}>{t.employee_name} · {t.employee_code} · {t.priority}</M></div><Status state={t.status}/></div>{t.description&&<div style={{fontSize:12,color:T.mute,marginTop:7,lineHeight:1.5}}>{t.description}</div>}<M style={{fontSize:11,color:T.faint,display:'block',marginTop:7}}>By {t.assigner_name} · Due {to12(t.due_time)}</M></div>)}</div>}
  </>;
}

function AEmployees({ isPhone }) {
  const T = useT();
  const api = useApi();
  const staff = useResource(() => api.admin.employees(), []);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

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
                  <button className="press" onClick={() => setEditing(e)} style={{ padding: '7px 10px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.bg, color: T.text, cursor: 'pointer' }}>Edit</button>
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
      {editing && (
        <EditEmployee employee={editing} isPhone={isPhone} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); staff.reload(); }} />
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

function EditEmployee({ employee, onClose, onDone, isPhone }) {
  const T = useT();
  const api = useApi();
  const [f, setF] = useState({
    name: employee.name || '', role: employee.role || 'Trainer', email: employee.email || '',
    phone: employee.phone || '', status: employee.status || 'Active',
    claimsEnabled: !!employee.claims_enabled, capFood: employee.cap_food ?? 500, capStay: employee.cap_stay ?? 1500,
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const set = (patch) => { setF({ ...f, ...patch }); setProblem(null); };
  const incomplete = !f.name.trim() || !f.email.trim() || (f.password.trim() && f.password.trim().length < 12);
  const submit = async () => {
    setBusy(true); setProblem(null);
    try {
      await api.admin.updateEmployee(employee.employee_id, {
        name: f.name.trim(), role: f.role, email: f.email.trim().toLowerCase(),
        phone: f.phone.trim() || null, status: f.status, claimsEnabled: f.claimsEnabled,
        capFood: Number(f.capFood) || 0, capStay: Number(f.capStay) || 0,
        ...(f.password.trim() ? { password: f.password.trim() } : {}),
      });
      onDone();
    } catch (e) { setProblem(e); }
    finally { setBusy(false); }
  };
  const label = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: T.faint, marginBottom: 8 };
  const field = { width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 14, background: 'transparent', border: `1px solid ${T.line}`, color: T.text, outline: 'none', fontFamily: 'inherit' };
  return (
    <div className="fade" style={{ position: 'fixed', inset: 0, background: T.overlay, zIndex: 60, display: 'flex', alignItems: isPhone ? 'flex-end' : 'center', justifyContent: 'center', padding: isPhone ? 0 : 16 }}>
      <div className="rise" style={{ width: '100%', maxWidth: 520, background: T.bg, padding: 28, borderRadius: isPhone ? '16px 16px 0 0' : 16, border: `1px solid ${T.line}`, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
          <div><div className="tight" style={{ fontSize: 18, fontWeight: 600 }}>Edit employee</div><M style={{ fontSize: 11, color: T.faint }}>{employee.employee_code}</M></div>
          <button className="press" onClick={onClose} style={{ background: 'none', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ marginBottom: 18 }}><div className="mono" style={label}>Name</div><input value={f.name} onChange={e => set({name:e.target.value})} style={field} /></div>
        <div style={{ marginBottom: 18 }}><div className="mono" style={label}>Role</div><div style={{display:'flex',flexWrap:'wrap',gap:8}}>{['Trainer','Technical Support','Admin','Accountant','Content Writer','Designer','CEO'].map(r => <button key={r} className="press" onClick={() => set({role:r})} style={{padding:'8px 12px',borderRadius:8,fontSize:12,cursor:'pointer',background:f.role===r?T.text:'transparent',color:f.role===r?T.bg:T.mute,border:`1px solid ${f.role===r?T.text:T.line}`}}>{r}</button>)}</div></div>
        <div style={{ display:'grid', gridTemplateColumns:isPhone?'1fr':'1fr 1fr', gap:16, marginBottom:18 }}>
          <div><div className="mono" style={label}>Email</div><input type="email" value={f.email} onChange={e => set({email:e.target.value})} style={field} /></div>
          <div><div className="mono" style={label}>Phone</div><input value={f.phone} onChange={e => set({phone:e.target.value})} style={field} /></div>
        </div>
        <div style={{display:'flex',gap:8,marginBottom:18}}>{['Active','Inactive'].map(v => <button key={v} className="press" onClick={() => set({status:v})} style={{padding:'8px 12px',borderRadius:8,fontSize:12,cursor:'pointer',background:f.status===v?T.text:'transparent',color:f.status===v?T.bg:T.mute,border:`1px solid ${f.status===v?T.text:T.line}`}}>{v}</button>)}</div>
        <div style={{ paddingTop:18, borderTop:`1px solid ${T.line}`, marginBottom:18 }}>
          <button className="press" onClick={() => set({claimsEnabled:!f.claimsEnabled})} style={{display:'flex',alignItems:'center',gap:12,background:'none',border:'none',cursor:'pointer',padding:0,textAlign:'left',color:T.text}}><span style={{width:34,height:20,borderRadius:999,position:'relative',background:f.claimsEnabled?T.accent:T.line}}><span style={{position:'absolute',width:14,height:14,borderRadius:'50%',top:3,left:f.claimsEnabled?17:3,background:T.bg}} /></span><span><span style={{fontSize:14,display:'block'}}>Reimbursement</span><span style={{fontSize:12,color:T.mute}}>Claims access and daily caps</span></span></button>
        </div>
        {f.claimsEnabled && <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:18}}>{[['Food, per day','capFood'],['Stay, per day','capStay']].map(([lbl,k])=><div key={k}><div className="mono" style={label}>{lbl}</div><input type="number" value={f[k]} onChange={e=>set({[k]:e.target.value})} style={field}/></div>)}</div>}
        <div style={{marginBottom:18}}><div className="mono" style={label}>Reset password (optional)</div><input value={f.password} onChange={e=>set({password:e.target.value})} placeholder="Leave blank to keep current password" style={field}/></div>
        {problem && <div style={{fontSize:13,color:T.accent,marginBottom:16,lineHeight:1.5}}>{problem.message}</div>}
        <div style={{display:'flex',gap:8}}><Btn variant="line" full onClick={onClose}>Cancel</Btn><Btn full busy={busy} disabled={incomplete} onClick={submit}>Save changes</Btn></div>
      </div>
    </div>
  );
}

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
                {['Trainer', 'Technical Support', 'Admin', 'Accountant', 'Content Writer', 'Designer'].map((r) => {
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
                Trainers and Technical Support can punch in/out from any location. Trainers also record school visit check-in/out at assigned schools.
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
