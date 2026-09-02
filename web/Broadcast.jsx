import React, { useState } from 'react';
import { newActionKey } from './api-client.js';

/**
 * Broadcasts — the CEO tells the team something.
 *
 * An announcement board, not a chat. No replies, no reactions, no threads.
 * Priority is carried by a word and a shape as well as colour, matching the
 * rest of the app so it stays readable without relying on colour alone.
 */

const PRIORITY_LABEL = { Normal: 'Notice', Important: 'Important', Urgent: 'Urgent' };

/* Home card. Silent when there is nothing unread, so it never nags. */
export function BroadcastCard({ T, broadcasts, onOpen }) {
  if (broadcasts.loading || broadcasts.error) return null;
  const unread = (broadcasts.data || []).filter((b) => !b.read);
  if (!unread.length) return null;

  const top = unread[0];
  return (
    <button className="press" onClick={onOpen} style={{
      display: 'block', width: '100%', textAlign: 'left', marginBottom: 40,
      background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.text,
    }}>
      <div style={{ paddingLeft: 14, borderLeft: `2px solid ${top.priority === 'Normal' ? T.line : T.accent}` }}>
        <div className="mono" style={{
          fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em',
          color: top.priority === 'Normal' ? T.faint : T.accent, marginBottom: 8,
        }}>
          {PRIORITY_LABEL[top.priority]}{unread.length > 1 ? ` · ${unread.length} unread` : ''}
        </div>
        <div style={{ fontSize: 16, fontWeight: 500, lineHeight: 1.4 }}>{top.title}</div>
        <div style={{ fontSize: 13, color: T.mute, marginTop: 6 }}>Tap to read</div>
      </div>
    </button>
  );
}

/* Employee list. Opening one marks it read. */
export function BroadcastList({ T, api, broadcasts, onBack }) {
  const [open, setOpen] = useState(null);

  const read = async (b) => {
    setOpen(b.broadcast_id);
    if (!b.read) {
      // Failing to record the read is not worth an error message; the
      // employee has still read it, and the next load will retry.
      try { await api.markBroadcastRead(b.broadcast_id); await broadcasts.reload(); } catch { /* ignore */ }
    }
  };

  return (
    <div style={{ padding: '28px 24px 40px' }}>
      <button className="press" onClick={onBack} style={{
        background: 'none', border: 'none', color: T.mute, fontSize: 12,
        cursor: 'pointer', padding: 0, marginBottom: 28,
      }}>← Back</button>

      <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: '0 0 24px' }}>Announcements</h1>

      {broadcasts.loading && (
        <div style={{ display: 'grid', gap: 14 }}>
          {[0, 1, 2].map((i) => <div key={i} className="pulse" style={{ height: 56, borderRadius: 6, background: T.hair }} />)}
        </div>
      )}

      {broadcasts.error && (
        <div style={{ padding: '24px 0' }}>
          <div style={{ fontSize: 13, color: T.accent }}>Couldn’t load announcements.</div>
          <button className="press" onClick={broadcasts.reload} style={{
            background: 'none', border: 'none', color: T.text, fontSize: 13, padding: '10px 0', cursor: 'pointer',
          }}>Try again</button>
        </div>
      )}

      {!broadcasts.loading && !broadcasts.error && !broadcasts.data.length && (
        <div style={{ padding: '56px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>No announcements yet</div>
          <div style={{ fontSize: 12, marginTop: 6, color: T.mute }}>
            Anything the CEO sends the team will appear here.
          </div>
        </div>
      )}

      {!broadcasts.loading && !broadcasts.error && broadcasts.data.map((b) => {
        const expanded = open === b.broadcast_id;
        const flagged = b.priority !== 'Normal';
        return (
          <div key={b.broadcast_id} style={{ borderBottom: `1px solid ${T.line}` }}>
            <button className="press" onClick={() => (expanded ? setOpen(null) : read(b))} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '18px 0',
              background: 'none', border: 'none', cursor: 'pointer', color: T.text,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                {/* Unread is a filled dot; read is nothing. Shape, not just colour. */}
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', marginTop: 7, flexShrink: 0,
                  background: b.read ? 'transparent' : (flagged ? T.accent : T.text),
                  border: b.read ? `1px solid ${T.line}` : 'none',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {flagged && (
                    <div className="mono" style={{
                      fontSize: 10, textTransform: 'uppercase', letterSpacing: '.14em',
                      color: T.accent, marginBottom: 6,
                    }}>{PRIORITY_LABEL[b.priority]}</div>
                  )}
                  <div style={{ fontSize: 15, fontWeight: b.read ? 400 : 500, lineHeight: 1.4 }}>{b.title}</div>
                  <div className="mono" style={{ fontSize: 11, color: T.faint, marginTop: 6 }}>
                    {b.published_by} · {new Date(b.published_at).toLocaleDateString('en-IN',
                      { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}
                  </div>
                </div>
              </div>
            </button>

            {expanded && (
              <div className="rise" style={{
                fontSize: 14, lineHeight: 1.65, color: T.mute,
                padding: '0 0 20px 19px', whiteSpace: 'pre-wrap',
              }}>{b.message}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* Admin: compose, then see what was sent and how far it got. */
export function AdminBroadcasts({ T, api, list, isPhone }) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState('Normal');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [sent, setSent] = useState(false);

  const publish = async () => {
    setBusy(true); setProblem(null); setSent(false);
    try {
      // One key for this composition: a double tap sends one announcement.
      await api.admin.publishBroadcast({ title: title.trim(), message: message.trim(), priority }, newActionKey());
      setTitle(''); setMessage(''); setPriority('Normal');
      setSent(true); await list.reload();
      setTimeout(() => setSent(false), 4000);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const incomplete = !title.trim() || !message.trim();
  const field = {
    width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 14,
    background: 'transparent', border: `1px solid ${T.line}`, color: T.text,
    outline: 'none', fontFamily: 'inherit',
  };
  const label = {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em',
    color: T.faint, marginBottom: 8,
  };

  return (
    <>
      <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 32px' }}>Announcements</h1>

      <div style={{
        display: 'grid', gap: isPhone ? 32 : 40,
        gridTemplateColumns: isPhone ? '1fr' : 'repeat(auto-fit,minmax(300px,1fr))',
      }}>
        <div>
          <div className="mono" style={{ ...label, marginBottom: 16 }}>New announcement</div>

          <div style={{ marginBottom: 20 }}>
            <div className="mono" style={label}>Title</div>
            <input value={title} onChange={(e) => { setTitle(e.target.value); setProblem(null); }}
              placeholder="Office Holiday" maxLength={140} style={field} />
          </div>

          <div style={{ marginBottom: 20 }}>
            <div className="mono" style={label}>Message</div>
            <textarea value={message} onChange={(e) => { setMessage(e.target.value); setProblem(null); }} rows={5}
              placeholder="Tomorrow will be a holiday. The office will remain closed."
              maxLength={4000} style={{ ...field, resize: 'vertical' }} />
          </div>

          <div style={{ marginBottom: 24 }}>
            <div className="mono" style={label}>Priority</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {['Normal', 'Important', 'Urgent'].map((p) => {
                const on = priority === p;
                return (
                  <button key={p} className="press" onClick={() => setPriority(p)} style={{
                    flex: 1, padding: '9px 0', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                    background: on ? (p === 'Normal' ? T.text : T.accent) : 'transparent',
                    color: on ? T.bg : T.mute,
                    border: `1px solid ${on ? (p === 'Normal' ? T.text : T.accent) : T.line}`,
                  }}>{p}</button>
                );
              })}
            </div>
          </div>

          {problem && (
            <div className="fade" style={{ fontSize: 13, color: T.accent, marginBottom: 16, lineHeight: 1.5 }}>
              {problem.message}
            </div>
          )}
          {sent && (
            <div className="pop" style={{ fontSize: 13, color: T.mute, marginBottom: 16 }}>
              Sent to the whole team.
            </div>
          )}

          <button className="press" onClick={publish} disabled={busy || incomplete} style={{
            padding: '12px 20px', borderRadius: 8, fontSize: 14, fontWeight: 500, border: 'none',
            background: busy || incomplete ? T.hair : T.text,
            color: busy || incomplete ? T.faint : T.bg,
            cursor: busy || incomplete ? 'default' : 'pointer',
          }}>{busy ? 'Sending…' : 'Send to everyone'}</button>

          <div style={{ fontSize: 12, color: T.faint, marginTop: 12 }}>
            Goes to all active employees. It cannot be edited or unsent.
          </div>
        </div>

        <div>
          <div className="mono" style={{ ...label, marginBottom: 16 }}>Sent</div>
          {list.loading ? (
            <div style={{ display: 'grid', gap: 14 }}>
              {[0, 1].map((i) => <div key={i} className="pulse" style={{ height: 48, borderRadius: 6, background: T.hair }} />)}
            </div>
          ) : list.error ? (
            <div style={{ fontSize: 13, color: T.accent }}>Couldn’t load sent announcements.</div>
          ) : !list.data.length ? (
            <div style={{ padding: '40px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Nothing sent yet</div>
            </div>
          ) : (
            <div style={{ borderTop: `1px solid ${T.line}` }}>
              {list.data.map((b) => (
                <div key={b.broadcast_id} style={{ padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{b.title}</div>
                      <div className="mono" style={{ fontSize: 11, color: T.faint, marginTop: 4 }}>
                        {new Date(b.published_at).toLocaleString('en-IN',
                          { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                        {b.priority !== 'Normal' && ` · ${b.priority}`}
                      </div>
                    </div>
                    {/* Read count, not analytics. Enough to know it landed. */}
                    <span className="mono" style={{ fontSize: 12, color: T.mute, whiteSpace: 'nowrap' }}>
                      {b.read_count}/{b.audience} read
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
