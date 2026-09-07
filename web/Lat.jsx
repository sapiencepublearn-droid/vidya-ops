import React, { useState } from 'react';

/**
 * LAT — Learning And Teaching.
 *
 * One word per screen during the test. A ten-field form on a phone is a
 * scroll-and-lose-your-place problem, and a single large input keeps the
 * keyboard from covering the question. Progress is shown as a bar rather
 * than a count, so nobody is doing arithmetic mid-test.
 */

/* Card on Home. Tells the employee the state of the day in one line. */
export function LatCard({ T, lat, onOpen }) {
  if (lat.loading) {
    return (
      <div style={{ marginBottom: 40 }}>
        <Eyebrow T={T}>Words today</Eyebrow>
        <div className="pulse" style={{ height: 38, borderRadius: 6, background: T.hair }} />
      </div>
    );
  }
  if (lat.error || lat.data?.stage === 'none') {
    return (
      <div style={{ marginBottom: 40 }}>
        <Eyebrow T={T}>Words today</Eyebrow>
        <div style={{ fontSize: 14, color: T.mute }}>
          {lat.error ? 'Couldn\u2019t load today\u2019s words.' : 'Not published yet.'}
        </div>
        {lat.error && (
          <button className="press" onClick={lat.reload}
            style={{ background: 'none', border: 'none', color: T.text, fontSize: 13, padding: '10px 0', cursor: 'pointer' }}>
            Try again
          </button>
        )}
      </div>
    );
  }

  const { stage, words, prompts, score, total } = lat.data;
  const label = stage === 'read' ? `${words.length} new words to read`
    : stage === 'test' ? `Test in progress, ${prompts.length} words`
      : `${score} out of ${total}`;
  const cta = stage === 'read' ? 'Read them' : stage === 'test' ? 'Continue test' : 'See answers';

  return (
    <div style={{ marginBottom: 40 }}>
      <Eyebrow T={T} right={stage === 'done'
        ? <span className="pop" style={{ fontSize: 12, color: T.mute }}>Done today</span> : null}>
        Words today
      </Eyebrow>
      <div className="tight" style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {stage === 'done' && (
        <div style={{ marginBottom: 16 }}><Meter T={T} value={score} max={total} /></div>
      )}
      <button className="press" onClick={onOpen} style={{
        width: '100%', padding: '12px 16px', borderRadius: 8, fontSize: 14, fontWeight: 500,
        cursor: 'pointer', marginTop: 8,
        background: stage === 'done' ? 'transparent' : T.text,
        color: stage === 'done' ? T.text : T.bg,
        border: stage === 'done' ? `1px solid ${T.line}` : 'none',
      }}>{cta}</button>
    </div>
  );
}

/* Full-screen flow: read → test → result. */
export function LatScreen({ T, api, lat, onBack }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const start = async () => {
    setBusy(true); setProblem(null);
    try { await api.latStart(); await lat.reload(); }
    catch (e) { setProblem(e); }
    finally { setBusy(false); }
  };

  if (lat.loading) return <Padded><Skeletons T={T} /></Padded>;
  if (lat.error) return (
    <Padded>
      <Back T={T} onBack={onBack} />
      <Problem T={T} error={lat.error} onRetry={lat.reload} />
    </Padded>
  );

  const d = lat.data;
  if (d.stage === 'none') return (
    <Padded>
      <Back T={T} onBack={onBack} />
      <Empty T={T} title="No words yet today" hint="They appear here once the CEO publishes them." />
    </Padded>
  );

  if (d.stage === 'read') return (
    <Padded>
      <Back T={T} onBack={onBack} />
      <h1 className="tight" style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>
        Today&rsquo;s {d.words.length} words
      </h1>
      <p style={{ fontSize: 13, color: T.mute, margin: '0 0 28px' }}>
        Read them, then take the test. You get one attempt.
      </p>

      <div style={{ borderTop: `1px solid ${T.line}` }}>
        {d.words.map((w) => (
          <div key={w.word_id} style={{ padding: '18px 0', borderBottom: `1px solid ${T.line}` }}>
            <div style={{ fontSize: 17, fontWeight: 500 }}>{w.word}</div>
            <div style={{ fontSize: 14, color: T.mute, marginTop: 6, lineHeight: 1.5 }}>{w.meaning}</div>
            {w.example && (
              <div style={{ fontSize: 13, color: T.faint, marginTop: 8, fontStyle: 'italic' }}>{w.example}</div>
            )}
          </div>
        ))}
      </div>

      {problem && <Problem T={T} error={problem} />}

      {/* Sticky so the action is reachable without scrolling back up. */}
      <div style={{ position: 'sticky', bottom: 0, background: T.bg, padding: '20px 0 32px' }}>
        <button className="press" onClick={start} disabled={busy} style={{
          width: '100%', padding: '14px', borderRadius: 8, fontSize: 15, fontWeight: 500,
          background: busy ? T.hair : T.accent, color: busy ? T.faint : '#fff',
          border: 'none', cursor: busy ? 'default' : 'pointer',
        }}>{busy ? 'Starting…' : 'Start test'}</button>
        <div style={{ fontSize: 12, color: T.faint, textAlign: 'center', marginTop: 10 }}>
          The words are hidden once the test begins.
        </div>
      </div>
    </Padded>
  );

  if (d.stage === 'test') return <LatTest T={T} api={api} data={d} onDone={lat.reload} />;
  return <LatResult T={T} data={d} onBack={onBack} />;
}

function LatTest({ T, api, data, onDone }) {
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const prompts = data.prompts;
  const p = prompts[i];
  const value = answers[p.word_id] || '';
  const last = i === prompts.length - 1;
  const answered = Object.values(answers).filter((v) => v.trim()).length;

  const next = () => { if (!last) setI(i + 1); };
  const submit = async () => {
    setBusy(true); setProblem(null);
    try {
      await api.latSubmit(data.attemptId, prompts.map((q) => ({ wordId: q.word_id, given: answers[q.word_id] || '' })));
      await onDone();
    } catch (e) { setProblem(e); setBusy(false); }
  };

  return (
    <Padded>
      <div style={{ paddingTop: 8, marginBottom: 32 }}>
        <Meter T={T} value={i + 1} max={prompts.length} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
          <span className="mono" style={{ fontSize: 11, color: T.faint }}>{i + 1} of {prompts.length}</span>
          <span className="mono" style={{ fontSize: 11, color: T.faint }}>{answered} answered</span>
        </div>
      </div>

      <div key={p.word_id} className="rise">
        <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em', color: T.faint, marginBottom: 14 }}>
          Spell the word
        </div>
        <div style={{ fontSize: 19, lineHeight: 1.5, marginBottom: 10 }}>{p.meaning}</div>
        <div className="mono" style={{ fontSize: 12, color: T.faint, marginBottom: 28 }}>
          {p.initial} · {p.length} letters
        </div>

        <input
          value={value} autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false}
          onChange={(e) => setAnswers({ ...answers, [p.word_id]: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && !last) next(); }}
          placeholder="Type the word"
          style={{
            width: '100%', padding: '14px 0', fontSize: 22, background: 'transparent',
            border: 'none', borderBottom: `2px solid ${value.trim() ? T.text : T.line}`,
            color: T.text, outline: 'none', borderRadius: 0,
          }} />
      </div>

      {problem && <Problem T={T} error={problem} />}

      <div style={{ position: 'sticky', bottom: 0, background: T.bg, padding: '28px 0 32px', display: 'flex', gap: 10 }}>
        {i > 0 && (
          <button className="press" onClick={() => setI(i - 1)} style={{
            padding: '14px 20px', borderRadius: 8, fontSize: 15, background: 'transparent',
            color: T.text, border: `1px solid ${T.line}`, cursor: 'pointer',
          }}>Back</button>
        )}
        <button className="press" onClick={last ? submit : next} disabled={busy} style={{
          flex: 1, padding: '14px', borderRadius: 8, fontSize: 15, fontWeight: 500,
          background: busy ? T.hair : last ? T.accent : T.text, color: busy ? T.faint : T.bg,
          border: 'none', cursor: busy ? 'default' : 'pointer',
        }}>
          {busy ? 'Submitting…' : last ? 'Submit test' : 'Next word'}
        </button>
      </div>
    </Padded>
  );
}

function LatResult({ T, data, onBack }) {
  const pct = Math.round((data.score / data.total) * 100);
  return (
    <Padded>
      <Back T={T} onBack={onBack} />
      <div className="pop" style={{ marginBottom: 36 }}>
        <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em', color: T.faint, marginBottom: 12 }}>
          Your mark
        </div>
        <div className="tight" style={{ fontSize: 48, fontWeight: 600, lineHeight: 1 }}>
          {data.score}<span style={{ fontSize: 24, color: T.faint }}> / {data.total}</span>
        </div>
        <div style={{ marginTop: 18 }}><Meter T={T} value={data.score} max={data.total} /></div>
        <div style={{ fontSize: 13, color: T.mute, marginTop: 12 }}>
          {pct === 100 ? 'Every word correct.' : pct >= 70 ? 'Good work. The misses are below.' : 'The words you missed are below, with the spelling.'}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${T.line}` }}>
        {data.answers.map((a) => (
          <div key={a.word_id} style={{ display: 'flex', gap: 14, padding: '16px 0', borderBottom: `1px solid ${T.line}` }}>
            <Mark T={T} correct={a.is_correct} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{a.word}</div>
              <div style={{ fontSize: 13, color: T.mute, marginTop: 4, lineHeight: 1.5 }}>{a.meaning}</div>
              {!a.is_correct && (
                <div style={{ fontSize: 13, color: T.accent, marginTop: 6 }}>
                  You wrote {a.given?.trim() ? `“${a.given.trim()}”` : 'nothing'}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ height: 40 }} />
    </Padded>
  );
}

/* ─────────────────────────────────────────────────────────── admin side */

export function AdminLat({ T, api, results, onPublished, isPhone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [ok, setOk] = useState(false);

  /* One word per line, "word — meaning". Typing ten words should not
     require ten pairs of form fields. */
  const parsed = text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [word, ...rest] = line.split(/\s*[—:|-]\s*/);
    return { word: (word || '').trim(), meaning: rest.join(' - ').trim() };
  }).filter((w) => w.word && w.meaning);

  const publish = async () => {
    setBusy(true); setProblem(null); setOk(false);
    try {
      await api.admin.publishWords(parsed);
      setText(''); setOk(true); await onPublished();
      setTimeout(() => setOk(false), 3000);
    } catch (e) { setProblem(e); }
    finally { setBusy(false); }
  };

  const taken = (results.data || []).filter((r) => r.submitted_at);
  const avg = taken.length
    ? Math.round(taken.reduce((s, r) => s + (r.score / r.total), 0) / taken.length * 100) : null;

  return (
    <>
      <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 32px' }}>Words</h1>

      <div style={{ display: 'grid', gap: isPhone ? 32 : 40, gridTemplateColumns: isPhone ? '1fr' : 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div>
          <Eyebrow T={T}>Publish today</Eyebrow>
          <textarea
            value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }} rows={10}
            placeholder={'conscience — an inner sense of right and wrong\nrhythm — a regular repeated pattern of sound'}
            style={{
              width: '100%', padding: 14, fontSize: 14, lineHeight: 1.7, borderRadius: 8,
              background: 'transparent', border: `1px solid ${T.line}`, color: T.text,
              outline: 'none', resize: 'vertical', fontFamily: 'inherit',
            }} />
          <div style={{ fontSize: 12, color: T.faint, marginTop: 10 }}>
            One per line, word then meaning. {parsed.length > 0 && `${parsed.length} ready.`}
          </div>

          {problem && <Problem T={T} error={problem} />}
          {ok && <div className="pop" style={{ fontSize: 13, color: T.mute, marginTop: 14 }}>Published. Everyone has been notified.</div>}

          <button className="press" onClick={publish} disabled={busy || !parsed.length} style={{
            marginTop: 18, padding: '12px 20px', borderRadius: 8, fontSize: 14, fontWeight: 500,
            background: busy || !parsed.length ? T.hair : T.text,
            color: busy || !parsed.length ? T.faint : T.bg,
            border: 'none', cursor: busy || !parsed.length ? 'default' : 'pointer',
          }}>{busy ? 'Publishing…' : `Publish ${parsed.length || ''} words`}</button>
        </div>

        <div>
          <Eyebrow T={T} right={avg !== null
            ? <span className="mono" style={{ fontSize: 11, color: T.faint }}>{avg}% average</span> : null}>
            Today&rsquo;s results
          </Eyebrow>
          {results.loading ? <Skeletons T={T} />
            : results.error ? <Problem T={T} error={results.error} onRetry={results.reload} />
              : <div style={{ borderTop: `1px solid ${T.line}` }}>
                {(results.data || []).map((r) => (
                  <div key={r.employee_id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: `1px solid ${T.line}` }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{r.name}</div>
                      <div style={{ fontSize: 12, color: T.mute, marginTop: 2 }}>{r.role}</div>
                    </div>
                    {r.submitted_at
                      ? <span className="mono" style={{ fontSize: 14 }}>{r.score}/{r.total}</span>
                      : <span style={{ fontSize: 12, color: r.started_at ? T.mute : T.faint }}>
                          {r.started_at ? 'in progress' : 'not taken'}
                        </span>}
                  </div>
                ))}
              </div>}
        </div>
      </div>
    </>
  );
}

/* ───────────────────────────────────────────────────────── small pieces */

const Padded = ({ children }) => <div style={{ padding: '28px 24px 0' }}>{children}</div>;

function Eyebrow({ T, children, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
      <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.14em', color: T.faint }}>{children}</div>
      {right}
    </div>
  );
}

function Meter({ T, value, max }) {
  return (
    <div style={{ height: 3, background: T.hair, borderRadius: 999, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${Math.round((value / max) * 100)}%`, background: T.text,
        borderRadius: 999, transition: 'width .3s cubic-bezier(.2,.8,.3,1)',
      }} />
    </div>
  );
}

/* Shape as well as colour, so the result is not carried by red alone. */
function Mark({ T, correct }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ marginTop: 3, flexShrink: 0 }}>
      {correct
        ? <path d="M3 8.5 L6.5 12 L13 4.5" fill="none" stroke={T.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        : <><line x1="4" y1="4" x2="12" y2="12" stroke={T.accent} strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="4" x2="4" y2="12" stroke={T.accent} strokeWidth="2" strokeLinecap="round" /></>}
    </svg>
  );
}

function Back({ T, onBack }) {
  return (
    <button className="press" onClick={onBack} style={{
      background: 'none', border: 'none', color: T.mute, fontSize: 12,
      cursor: 'pointer', padding: 0, marginBottom: 28,
    }}>← Back</button>
  );
}

function Problem({ T, error, onRetry }) {
  return (
    <div className="fade" style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13, color: T.accent, lineHeight: 1.5 }}>{error?.message || 'Something went wrong.'}</div>
      {onRetry && (
        <button className="press" onClick={onRetry} style={{
          background: 'none', border: 'none', color: T.text, fontSize: 13,
          padding: '10px 0', cursor: 'pointer',
        }}>Try again</button>
      )}
    </div>
  );
}

function Empty({ T, title, hint }) {
  return (
    <div style={{ padding: '56px 0', textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, marginTop: 6, color: T.mute }}>{hint}</div>}
    </div>
  );
}

function Skeletons({ T, n = 4 }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="pulse" style={{ height: 38, borderRadius: 6, background: T.hair }} />
      ))}
    </div>
  );
}
