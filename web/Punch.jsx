import React, { useState, useRef } from 'react';
import { newActionKey, readFix } from './api-client.js';

/**
 * Punch In / Punch Out.
 *
 * The employee is never asked where they are. They press one button; the
 * phone reports GPS; the server decides office or school and which one.
 * Nothing here classifies location, and nothing here is sent to the server
 * except the raw fix.
 */

const istTime = (t) => t ? new Date(t).toLocaleTimeString('en-IN',
  { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
const istDay = (d) => d ? new Date(d).toLocaleDateString('en-IN',
  { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }) : '';

/**
 * Server failures rendered as something an employee can act on.
 * Anti-spoofing detail is deliberately not explained.
 */
function messageFor(e) {
  switch (e?.code) {
    case 'location_denied':
      return { title: 'Location permission is required to record attendance.',
               help: 'Allow location for this site in your browser settings, then try again.' };
    case 'no_geolocation':
      return { title: 'This device cannot report its location.',
               help: 'Attendance needs GPS. Try another device or tell your admin.' };
    case 'poor_accuracy':
      return { title: 'Your location accuracy is currently too low.',
               help: 'Move to an open area away from buildings and try again.' };
    case 'outside_radius':
      return { title: 'You are not currently inside an approved attendance location.',
               help: 'Move closer and try again. If you are at the right place, report it below.' };
    case 'ambiguous_location':
      return { title: 'Your location is too close to multiple approved school locations. Attendance was not recorded.',
               help: 'Please move to a clearer location and try again.' };
    case 'no_site':
      return { title: 'No attendance location is set up for you yet.',
               help: 'Ask your admin to assign your office or school.' };
    case 'mock_location':
      // Generic on purpose: how spoofing is detected is not explained.
      return { title: 'Attendance could not be recorded from this device.',
               help: 'Please try again, or contact your admin if this continues.' };
    case 'network_error':
      return { title: 'Could not reach the server.', help: 'Check your connection and try again.' };
    default:
      return { title: e?.message || 'Attendance could not be recorded.', help: null };
  }
}

export function PunchPanel({ T, api, att, loading, error, onDone, onRetryLoad, M, Btn }) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(null);
  const [problem, setProblem] = useState(null);
  const [result, setResult] = useState(null);     // punch-in or punch-out response
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  // Held across retries of one tap, so a lost response cannot double-punch.
  const actionKey = useRef(null);

  const reasonFor = (e) => ({
    outside_radius: 'outside_radius', poor_accuracy: 'poor_accuracy',
    ambiguous_location: 'other', mock_location: 'mock_location',
    location_denied: 'permission_denied', no_geolocation: 'gps_unavailable',
    network_error: 'network_unavailable',
  }[e?.code] || (e?.status >= 500 ? 'server_unavailable' : 'other'));

  const punch = async (mode) => {
    setBusy(true); setProblem(null); setReported(false);
    if (!actionKey.current) actionKey.current = newActionKey();
    try {
      setStage('Getting location…');
      const fix = await readFix();
      setStage(mode === 'in' ? 'Checking attendance location…' : 'Completing attendance…');
      const r = mode === 'in'
        ? await api.checkIn(fix, actionKey.current)
        : await api.checkOut(fix, actionKey.current);
      actionKey.current = null;
      setResult({ mode, ...r });
      await onDone();
    } catch (e) {
      setProblem({ ...e, code: e.code, status: e.status, mode });
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
        note: (problem.message || '').slice(0, 900),
      }, newActionKey());
      setReported(true);
    } catch (e) {
      setReported(e.code === 'incident_exists');
    } finally {
      setReporting(false);
    }
  };

  const label = {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em',
    color: T.faint, marginBottom: 10,
  };

  if (loading) {
    return (
      <div style={{ marginBottom: 40 }}>
        <div className="mono" style={label}>Attendance</div>
        <div className="pulse" style={{ height: 44, width: '60%', borderRadius: 6, background: T.hair }} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ marginBottom: 40 }}>
        <div className="mono" style={label}>Attendance</div>
        <div style={{ fontSize: 13, color: T.accent }}>Couldn’t load your attendance.</div>
        <button className="press" onClick={onRetryLoad} style={{
          background: 'none', border: 'none', color: T.text, fontSize: 13, padding: '10px 0', cursor: 'pointer',
        }}>Try again</button>
      </div>
    );
  }

  // Completed for the day: show the summary, and the draft if it was a school.
  if (att?.check_out_time || result?.mode === 'out') {
    return <Completed T={T} att={att} result={result} M={M} Btn={Btn} label={label} />;
  }

  // Punched in, still out in the field.
  if (att?.check_in_time) {
    const type = att.location_type || result?.locationType;
    const place = att.site_name || result?.location;
    const zone = att.site_zone || result?.zone;
    return (
      <div style={{ marginBottom: 40 }}>
        <div className="mono" style={label}>
          {type === 'SCHOOL' ? 'School visit' : 'Office attendance'}
        </div>
        <div className="tight" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1, marginBottom: 10 }}>
          {istTime(att.check_in_time)}
        </div>
        <div style={{ fontSize: 14, marginBottom: 4 }}>{place || '—'}</div>
        {type === 'SCHOOL' && zone && (
          <M style={{ fontSize: 12, color: T.mute, display: 'block' }}>Zone: {zone}</M>
        )}
        <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 8, marginBottom: 24 }}>
          {att.status}{att.check_in_accuracy ? ` · ±${att.check_in_accuracy} m` : ''}
        </M>

        <BigButton T={T} busy={busy} stage={stage} onClick={() => punch('out')}
          label="Punch Out" variant="line" />
        <Problem T={T} problem={problem} reported={reported} reporting={reporting}
          onRetry={() => punch(problem.mode)} onReport={report} Btn={Btn} M={M} />
      </div>
    );
  }

  // Not punched in yet.
  return (
    <div style={{ marginBottom: 40 }}>
      <div className="mono" style={label}>Attendance</div>
      <div className="tight" style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>Not punched in</div>
      <div style={{ fontSize: 13, color: T.mute, marginBottom: 20, lineHeight: 1.6 }}>
        Press Punch In. Your location is read once and the office or school is worked out for you.
      </div>
      <BigButton T={T} busy={busy} stage={stage} onClick={() => punch('in')}
        label="Punch In" variant="accent" />
      <Problem T={T} problem={problem} reported={reported} reporting={reporting}
        onRetry={() => punch(problem.mode)} onReport={report} Btn={Btn} M={M} />
    </div>
  );
}

/** Large, unmissable, and disabled while a request is in flight. */
function BigButton({ T, busy, stage, onClick, label, variant }) {
  return (
    <>
      <button className="press" onClick={busy ? undefined : onClick} disabled={busy}
        style={{
          width: '100%', padding: '18px', borderRadius: 12, fontSize: 17, fontWeight: 600,
          border: variant === 'line' ? `1px solid ${T.line}` : 'none',
          background: busy ? T.hair : variant === 'accent' ? T.accent : 'transparent',
          color: busy ? T.faint : variant === 'accent' ? '#fff' : T.text,
          cursor: busy ? 'default' : 'pointer',
        }}>
        {busy ? 'Working…' : label}
      </button>
      {busy && stage && (
        <div className="fade" style={{ fontSize: 12, color: T.mute, marginTop: 12, textAlign: 'center' }}>
          {stage}
        </div>
      )}
    </>
  );
}

function Problem({ T, problem, reported, reporting, onRetry, onReport, Btn, M }) {
  if (reported) {
    return (
      <div className="pop" style={{ fontSize: 13, color: T.mute, marginTop: 20, lineHeight: 1.6 }}>
        Reported. Your admin has been told and will sort it out.
        Your attendance for today is still not recorded.
      </div>
    );
  }
  if (!problem) return null;
  const m = messageFor(problem);
  return (
    <div className="fade" style={{ marginTop: 20 }}>
      <div style={{ fontSize: 14, color: T.accent, lineHeight: 1.5 }}>{m.title}</div>
      {m.help && <div style={{ fontSize: 13, color: T.mute, marginTop: 8, lineHeight: 1.6 }}>{m.help}</div>}
      {problem.requestId && (
        <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 8 }}>
          ref {problem.requestId.slice(0, 8)}
        </M>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <Btn variant="line" onClick={onRetry}>Try again</Btn>
        {/* Offered only after a failure, so it is never the easy path. */}
        <Btn variant="line" busy={reporting} onClick={onReport}>Report the problem</Btn>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── completed attendance */

function Completed({ T, att, result, M, Btn, label }) {
  const type = result?.locationType || att?.location_type;
  const place = result?.location || att?.site_name;
  const zone = result?.zone || att?.site_zone;
  const draft = result?.visitDraft || null;

  return (
    <div className="pop" style={{ marginBottom: 40 }}>
      <div className="mono" style={label}>Attendance completed</div>
      <div className="tight" style={{ fontSize: 22, fontWeight: 600, marginBottom: 16 }}>
        {type === 'SCHOOL' ? 'School visit' : 'Office attendance'}
      </div>

      <div style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
        {[
          ['Date', istDay(att?.work_date)],
          [type === 'SCHOOL' ? 'School' : 'Location', place || '—'],
          ...(type === 'SCHOOL' && zone ? [['Zone', zone]] : []),
          ['Punch In', istTime(att?.check_in_time)],
          ['Punch Out', istTime(att?.check_out_time)],
          ['Status', att?.status || '—'],
        ].map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 14 }}>
            <span style={{ color: T.mute }}>{k}</span>
            <span style={{ textAlign: 'right' }}>{v}</span>
          </div>
        ))}
      </div>

      {/* School visits only. Office attendance has no group to update. */}
      {type === 'SCHOOL' && draft && <WhatsAppDraft T={T} draft={draft} Btn={Btn} />}
    </div>
  );
}

/**
 * Hands the employee prepared text. Sapience Team never sends anything:
 * the employee picks the group and presses Send in WhatsApp themselves.
 * The attendance record is the source of truth; this message is a
 * convenience and is not evidence.
 */
function WhatsAppDraft({ T, draft, Btn }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const open = () => {
    const url = `https://wa.me/?text=${encodeURIComponent(draft)}`;
    const w = window.open(url, '_blank', 'noopener');
    // Popup blockers and in-app browsers can refuse this silently.
    if (!w) { setBlocked(true); setShown(true); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setShown(true); // no clipboard access: show it so they can select it
    }
  };

  return (
    <div style={{ paddingTop: 20, borderTop: `1px solid ${T.line}` }}>
      <div style={{ fontSize: 13, color: T.mute, marginBottom: 14, lineHeight: 1.6 }}>
        A visit update is ready. WhatsApp will open with the text — choose the group
        and press Send yourself. Nothing is sent automatically.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn onClick={open}>Open WhatsApp Draft</Btn>
        <Btn variant="line" onClick={copy}>{copied ? 'Copied' : 'Copy message'}</Btn>
        <Btn variant="line" onClick={() => setShown(!shown)}>{shown ? 'Hide text' : 'Show text'}</Btn>
      </div>

      {blocked && (
        <div className="fade" style={{ fontSize: 13, color: T.accent, marginTop: 14, lineHeight: 1.6 }}>
          WhatsApp could not be opened from here. Copy the message below and paste it into your group.
        </div>
      )}

      {shown && (
        <pre className="rise" style={{
          marginTop: 14, padding: 14, borderRadius: 10, border: `1px solid ${T.line}`,
          background: T.sub, color: T.text, fontSize: 13, lineHeight: 1.7,
          whiteSpace: 'pre-wrap', fontFamily: 'inherit', overflowX: 'auto',
        }}>{draft}</pre>
      )}
    </div>
  );
}
