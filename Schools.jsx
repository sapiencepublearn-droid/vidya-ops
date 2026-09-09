import React, { useState, useMemo, useEffect } from 'react';
import { newActionKey } from './api-client.js';
import { SchoolMap, EvidenceMap, googleMapsUrl } from './SchoolMap.jsx';

/**
 * Schools — the places trainers visit.
 *
 * The school directory is readable by every signed-in employee. Editing,
 * assignment, history changes, and other admin controls remain admin-only.
 *
 * Sized for roughly 140 schools: a search box and a zone filter over a
 * plain list. No map, no clustering, no virtualised grid.
 */

const istDate = (d) => d ? new Date(d).toLocaleDateString('en-IN',
  { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) : '—';
const istTime = (t) => t ? new Date(t).toLocaleTimeString('en-IN',
  { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';


/** Read-only school directory for trainers and other employees. */
export function EmployeeSchools({ T, api, isPhone, useResource, Btn, ErrorBlock, Rows, Blank, M }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [mapOpen, setMapOpen] = useState(false);
  const schools = useResource(() => api.schools('?active=true'), []);
  const list = schools.data || [];

  const filtered = list.filter((s) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return String(s.name || '').toLowerCase().includes(needle)
      || String(s.zone || '').toLowerCase().includes(needle)
      || String(s.address || '').toLowerCase().includes(needle);
  });

  if (open) {
    return <EmployeeSchoolDetail T={T} api={api} id={open} isPhone={isPhone}
      onBack={() => { setOpen(null); schools.reload(); }} useResource={useResource}
      Btn={Btn} ErrorBlock={ErrorBlock} Rows={Rows} M={M} />;
  }

  const input = {
    padding: '10px 12px', borderRadius: 8, fontSize: 14, background: 'transparent',
    border: `1px solid ${T.line}`, color: T.text, outline: 'none', width: '100%',
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 20 }}>
        <div>
          <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Schools</h1>
          <div style={{ fontSize: 12, color: T.mute, marginTop: 5 }}>Find your school and its location.</div>
        </div>
        <Btn variant="line" onClick={() => setMapOpen(true)}>School Map</Btn>
      </div>

      <input value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search school, zone or address" style={{ ...input, marginBottom: 18 }} />

      {schools.loading ? <Rows n={6} />
        : schools.error ? <ErrorBlock error={schools.error} onRetry={schools.reload} />
        : !filtered.length ? <Blank title={list.length ? 'No schools match your search' : 'No schools available'} />
        : (
          <div style={{ borderTop: `1px solid ${T.line}` }}>
            {filtered.map((s) => (
              <button key={s.location_id} className="row press" onClick={() => setOpen(s.location_id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '15px 0', background: 'none', border: 'none', borderBottom: `1px solid ${T.line}`, cursor: 'pointer', color: T.text }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: T.mute, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.zone}{s.address ? ` · ${s.address}` : ''}
                    </div>
                  </div>
                  <span style={{ color: T.faint, fontSize: 18 }}>›</span>
                </div>
              </button>
            ))}
          </div>
        )}

      {mapOpen && <SchoolMap T={T} schools={list} isPhone={isPhone}
        onViewDetails={(id) => { setMapOpen(false); setOpen(id); }}
        onClose={() => setMapOpen(false)} />}
    </>
  );
}

function EmployeeSchoolDetail({ T, api, id, onBack, isPhone, useResource, Btn, ErrorBlock, Rows, M }) {
  const detail = useResource(() => api.school(id), [id]);
  const back = (
    <div style={{ position: isPhone ? 'sticky' : 'static', top: isPhone ? 56 : undefined, zIndex: 10, background: T.bg, padding: '8px 0 10px', marginBottom: 16, borderBottom: `1px solid ${T.line}` }}>
      <button className="press" onClick={onBack} aria-label="Back to schools" style={{ background: 'none', border: 'none', color: T.text, fontSize: 13, cursor: 'pointer', padding: '6px 0', fontWeight: 500 }}>← Back to Schools</button>
    </div>
  );

  if (detail.loading) return <>{back}<Rows n={5} /></>;
  if (detail.error) return <>{back}<ErrorBlock error={detail.error} onRetry={detail.reload} /></>;

  const s = detail.data;
  const maps = googleMapsUrl(s);
  return (
    <div>
      {back}
      <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: '0 0 6px' }}>{s.name}</h1>
      <div style={{ fontSize: 13, color: T.mute, marginBottom: 26 }}>{s.zone}{s.is_active ? '' : ' · inactive'}</div>

      <div style={{ borderTop: `1px solid ${T.line}` }}>
        {[
          ['Address', s.address],
          ['Contact', s.contact_person],
          ['Designation', s.contact_designation],
        ].filter(([, v]) => v).map(([k, v]) => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: isPhone ? '100px 1fr' : '140px 1fr', gap: 12, padding: '13px 0', borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
            <span style={{ color: T.mute }}>{k}</span><span style={{ overflowWrap: 'anywhere' }}>{v}</span>
          </div>
        ))}
        {s.contact_phone && (
          <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '100px 1fr' : '140px 1fr', gap: 12, padding: '13px 0', borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
            <span style={{ color: T.mute }}>Phone</span><a href={`tel:${s.contact_phone}`} style={{ color: T.text }}>{s.contact_phone}</a>
          </div>
        )}
      </div>

      {maps && (
        <a className="press" href={maps} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 20, color: T.text, fontSize: 13 }}>Open location in Google Maps ↗</a>
      )}

      {maps && (
        <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${T.line}` }}>
          <div className="mono" style={{ fontSize: 11, color: T.faint }}>LOCATION</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>{Number(s.latitude).toFixed(6)}, {Number(s.longitude).toFixed(6)}</div>
        </div>
      )}
    </div>
  );
}

export function AdminSchools({ T, api, isPhone, useResource, Btn, ErrorBlock, Rows, Blank, M }) {
  const [q, setQ] = useState('');
  const [zone, setZone] = useState('All');
  const [active, setActive] = useState('active');
  const [editing, setEditing] = useState(null);   // school object, or 'new'
  const [open, setOpen] = useState(null);         // school id for detail
  const [mapOpen, setMapOpen] = useState(false);

  const schools = useResource(() => api.schools(), []);
  const list = schools.data || [];

  const zones = useMemo(
    () => ['All', ...Array.from(new Set(list.map((s) => s.zone).filter(Boolean))).sort()],
    [list]);

  const filtered = list.filter((s) => {
    if (active === 'active' && !s.is_active) return false;
    if (active === 'inactive' && s.is_active) return false;
    if (zone !== 'All' && s.zone !== zone) return false;
    if (!q.trim()) return true;
    const needle = q.trim().toLowerCase();
    return s.name.toLowerCase().includes(needle)
      || (s.zone || '').toLowerCase().includes(needle)
      || (s.address || '').toLowerCase().includes(needle);
  });

  if (open) {
    return <SchoolDetail T={T} api={api} id={open} isPhone={isPhone}
      onBack={() => { setOpen(null); schools.reload(); }}
      onEdit={(s) => { setEditing(s); setOpen(null); }} useResource={useResource}
      Btn={Btn} ErrorBlock={ErrorBlock} Rows={Rows} Blank={Blank} M={M} />;
  }

  const input = {
    padding: '9px 12px', borderRadius: 8, fontSize: 14, background: 'transparent',
    border: `1px solid ${T.line}`, color: T.text, outline: 'none',
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 24 }}>
        <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Schools</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="line" onClick={() => setMapOpen(true)}>School Map</Btn>
          <Btn onClick={() => setEditing('new')}>Add school</Btn>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap',
        flexDirection: isPhone ? 'column' : 'row',
      }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, zone or address"
          style={{ ...input, flex: 1, minWidth: isPhone ? '100%' : 220 }} />
        <select value={zone} onChange={(e) => setZone(e.target.value)} style={input}>
          {zones.map((z) => <option key={z} value={z}>{z === 'All' ? 'All zones' : z}</option>)}
        </select>
        <select value={active} onChange={(e) => setActive(e.target.value)} style={input}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
      </div>

      {schools.loading ? <Rows n={6} />
        : schools.error ? <ErrorBlock error={schools.error} onRetry={schools.reload} />
          : !filtered.length ? <Blank title={list.length ? 'No schools match those filters' : 'No schools yet'}
              hint={list.length ? 'Clear a filter to see the rest.' : 'Add one with its verified coordinates.'} />
            : (
              <>
                <M style={{ fontSize: 11, color: T.faint, display: 'block', marginBottom: 12 }}>
                  {filtered.length} of {list.length}
                </M>
                <div style={{ borderTop: `1px solid ${T.line}` }}>
                  {filtered.map((s) => (
                    <button key={s.location_id} className="row press" onClick={() => setOpen(s.location_id)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '14px 0',
                        background: 'none', border: 'none', borderBottom: `1px solid ${T.line}`,
                        cursor: 'pointer', color: T.text,
                      }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>
                            {s.name}
                            {!s.is_active && (
                              <span style={{ fontSize: 11, color: T.faint, fontWeight: 400 }}> · inactive</span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: T.mute, marginTop: 3 }}>
                            {s.zone}{s.address ? ` · ${s.address}` : ''}
                          </div>
                        </div>
                        <M style={{
                          fontSize: 11, whiteSpace: 'nowrap',
                          color: s.latitude === null ? T.accent : T.faint,
                        }}>
                          {s.latitude === null ? 'Location not set' : `${s.radius_metres} m`}
                        </M>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}

      {mapOpen && (
        <SchoolMap T={T} schools={list} isPhone={isPhone}
          onViewDetails={(id) => setOpen(id)} onClose={() => setMapOpen(false)} />
      )}

      {editing && (
        <SchoolForm T={T} api={api} isPhone={isPhone}
          school={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); schools.reload(); }}
          Btn={Btn} />
      )}
    </>
  );
}

/* ─────────────────────────────────────────────────────────── detail */

function SchoolDetail({ T, api, id, onBack, onEdit, isPhone, useResource, Btn, ErrorBlock, Rows, Blank, M }) {
  const detail = useResource(() => api.school(id), [id]);
  const team = useResource(() => api.admin.employees(), []);
  // Reports carry the GPS a trainer's phone recorded at the gate. Useful
  // evidence, but never adopted without an admin saying so.
  const incidents = useResource(() => api.admin.incidents('Open'), []);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [historyEditing, setHistoryEditing] = useState(false);

  const assign = async (employeeId, remove) => {
    setBusy(employeeId); setProblem(null);
    try { await api.admin.assignSchool(id, employeeId, remove); await detail.reload(); }
    catch (e) { setProblem(e); }
    finally { setBusy(null); }
  };

  const back = (
    <div style={{
      position: isPhone ? 'sticky' : 'static', top: isPhone ? 56 : undefined, zIndex: isPhone ? 10 : undefined,
      background: T.bg, padding: isPhone ? '8px 0 10px' : 0, marginBottom: 16,
      borderBottom: isPhone ? `1px solid ${T.line}` : 'none',
    }}>
      <button className="press" onClick={onBack} aria-label="Back to schools" style={{
        background: 'none', border: 'none', color: T.text, fontSize: 13,
        cursor: 'pointer', padding: '6px 0', fontWeight: 500,
      }}>← Back to Schools</button>
    </div>
  );

  if (detail.loading) return <>{back}<Rows n={5} /></>;
  if (detail.error) return <>{back}<ErrorBlock error={detail.error} onRetry={detail.reload} /></>;

  const s = detail.data;
  const assignedIds = new Set((s.assignedEmployees || []).map((e) => e.employee_id));
  const unassigned = (team.data || []).filter((e) => !assignedIds.has(e.employee_id) && !e.is_admin);
  const label = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: T.faint, marginBottom: 6 };

  return (
    <>
      {back}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 8 }}>
        <h1 className="tight" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>{s.name}</h1>
        <Btn variant="line" onClick={() => onEdit(s)}>Edit</Btn>
      </div>
      <M style={{ fontSize: 12, color: T.mute, display: 'block', marginBottom: 32 }}>
        {s.zone}{s.is_active ? '' : ' · inactive'}
      </M>

      <div style={{
        display: 'grid', gap: 20, marginBottom: 28,
        gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(auto-fit,minmax(140px,1fr))',
      }}>
        {[['Radius', `${s.radius_metres} m`], ['Status', s.is_active ? 'Active' : 'Inactive'],
          ...(s.contact_person ? [['Contact', s.contact_person]] : []),
          ...(s.contact_phone ? [['Phone', s.contact_phone]] : [])].map(([k, v]) => (
          <div key={k}>
            <div className="mono" style={label}>{k}</div>
            <M style={{ fontSize: 14 }}>{v}</M>
          </div>
        ))}
      </div>

      {/* A school with no position cannot be matched, so this states it
          plainly rather than showing an empty coordinate field. */}
      <div style={{ marginBottom: 40 }}>
        <div className="mono" style={label}>Location</div>
        {s.latitude === null ? (
          <>
            <div style={{ fontSize: 14, color: T.accent, marginBottom: 8 }}>Location not set</div>
            <div style={{ fontSize: 12, color: T.mute, lineHeight: 1.6, marginBottom: 14 }}>
              Nobody can punch in here until a position is confirmed. Either enter
              coordinates from Google Maps, or confirm one from a trainer's report below.
            </div>
            <Btn variant="line" onClick={() => onEdit(s)}>Set School Location</Btn>
          </>
        ) : (
          <>
            <a className="press" href={googleMapsUrl(s)} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 14, color: T.text, display: 'inline-block' }}>
              Open location in Google Maps
            </a>
            {s.location_set_at && (
              <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 6 }}>
                confirmed {new Date(s.location_set_at).toLocaleDateString('en-IN',
                  { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}
              </M>
            )}
          </>
        )}
      </div>

      {s.address && (
        <div style={{ marginBottom: 40 }}>
          <div className="mono" style={label}>Address</div>
          <div style={{ fontSize: 14, color: T.mute, lineHeight: 1.6 }}>{s.address}</div>
        </div>
      )}

      <SchoolHistoryCard T={T} api={api} school={s} editing={historyEditing} setEditing={setHistoryEditing} M={M} Btn={Btn} onSaved={() => detail.reload()} isPhone={isPhone} />

      {/* Assignment is an authorization control, so it is stated plainly. */}
      <div className="mono" style={{ ...label, marginBottom: 12 }}>Assigned employees</div>
      <div style={{ fontSize: 12, color: T.mute, marginBottom: 16, lineHeight: 1.6 }}>
        Only these people can punch in here. Everyone else is refused, even standing at the gate.
      </div>

      {problem && (
        <div className="fade" style={{ fontSize: 13, color: T.accent, marginBottom: 16 }}>{problem.message}</div>
      )}

      <div style={{ borderTop: `1px solid ${T.line}`, marginBottom: 28 }}>
        {!(s.assignedEmployees || []).length && (
          <div style={{ padding: '20px 0', fontSize: 13, color: T.mute }}>
            Nobody is assigned, so nobody can punch in here yet.
          </div>
        )}
        {(s.assignedEmployees || []).map((e) => (
          <div key={e.employee_id} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 0', borderBottom: `1px solid ${T.line}`,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>{e.name}</div>
              <div style={{ fontSize: 12, color: T.faint }}>{e.role}</div>
            </div>
            <Btn variant="line" busy={busy === e.employee_id}
              onClick={() => assign(e.employee_id, true)}>Remove</Btn>
          </div>
        ))}
      </div>

      {unassigned.length > 0 && (
        <>
          <div className="mono" style={{ ...label, marginBottom: 12 }}>Add someone</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 40 }}>
            {unassigned.map((e) => (
              <button key={e.employee_id} className="press" disabled={busy === e.employee_id}
                onClick={() => assign(e.employee_id, false)}
                style={{
                  padding: '8px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                  background: 'transparent', color: T.text, border: `1px solid ${T.line}`,
                }}>
                + {e.name}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Only offered when there is nothing trusted yet, so a confirmed
          coordinate is never quietly replaced by a later reading. */}
      {s.latitude === null && (incidents.data || []).some((i) => i.reported_latitude !== null) && (
        <div style={{ marginBottom: 40 }}>
          <div className="mono" style={{ ...label, marginBottom: 12 }}>Positions reported by employees</div>
          <div style={{ fontSize: 12, color: T.mute, marginBottom: 16, lineHeight: 1.6 }}>
            Recorded when a punch failed. Check it looks right before confirming it
            as this school's permanent location.
          </div>
          {(incidents.data || []).filter((i) => i.reported_latitude !== null).slice(0, 5).map((i) => (
            <div key={i.incident_id} style={{
              padding: 14, borderRadius: 10, border: `1px solid ${T.line}`, marginBottom: 12,
            }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>{i.employee_name}</div>
              <M style={{ fontSize: 11, color: T.faint, display: 'block', marginBottom: 10 }}>
                {new Date(i.created_at).toLocaleString('en-IN',
                  { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                {i.reported_accuracy ? ` · ±${i.reported_accuracy} m` : ''}
              </M>
              <EvidenceMap T={T} latitude={i.reported_latitude} longitude={i.reported_longitude}
                accuracy={i.reported_accuracy} label={i.employee_name} />
              <div style={{ marginTop: 12 }}>
                {confirming === i.incident_id ? (
                  <div className="rise">
                    <div style={{ fontSize: 13, color: T.accent, marginBottom: 10, lineHeight: 1.6 }}>
                      Set this as {s.name}'s permanent location? Attendance will be
                      matched against it from now on.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn variant="line" onClick={() => setConfirming(null)}>Cancel</Btn>
                      <Btn busy={busy === i.incident_id} onClick={async () => {
                        setBusy(i.incident_id); setProblem(null);
                        try {
                          await api.admin.setSchoolLocationFromIncident(id,
                            { incidentId: i.incident_id, confirm: true }, newActionKey());
                          setConfirming(null);
                          await detail.reload();
                        } catch (e) { setProblem(e); }
                        finally { setBusy(null); }
                      }}>Yes, confirm location</Btn>
                    </div>
                  </div>
                ) : (
                  <Btn variant="line" onClick={() => setConfirming(i.incident_id)}>
                    Set School Location from this
                  </Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mono" style={{ ...label, marginBottom: 12 }}>Recent visits</div>
      {!(s.recentVisits || []).length
        ? <Blank title="No visits recorded here yet" />
        : (
          <div style={{ borderTop: `1px solid ${T.line}` }}>
            {s.recentVisits.map((v, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 0', borderBottom: `1px solid ${T.line}`,
              }}>
                <M style={{ fontSize: 12, color: T.faint, width: 60 }}>{istDate(v.work_date)}</M>
                <div style={{ flex: 1, fontSize: 14 }}>{v.employee_name}</div>
                <M style={{ fontSize: 12, color: T.mute }}>
                  {istTime(v.check_in_time)} – {v.check_out_time ? istTime(v.check_out_time) : '—'}
                </M>
              </div>
            ))}
          </div>
        )}
    </>
  );
}

/* ──────────────────────────────────────────────────── add and edit */


const historySections = [
  ['Basic details', [['location','Location'], ['vintage','Vintage'], ['books','Books'], ['category','Category']]],
  ['Contacts', [['contacts.correspondent','Correspondent'], ['contacts.correspondentPhone','Correspondent Phone'], ['contacts.principal','Principal'], ['contacts.principalPhone','Principal Phone'], ['contacts.keyPerson','Key Person'], ['contacts.keyPersonPhone','Key Person Phone']]],
  ['Books & Payment', [['booksPayment.lkg','LKG — Initial Count'], ['booksPayment.lkgAdditionalOrders','LKG — Additional Orders'], ['booksPayment.lkgReturns','LKG — Returns'], ['booksPayment.ukg','UKG — Initial Count'], ['booksPayment.ukgAdditionalOrders','UKG — Additional Orders'], ['booksPayment.ukgReturns','UKG — Returns'], ['booksPayment.lkgHhp','LKG — HHP'], ['booksPayment.ukgHhp','UKG — HHP'], ['booksPayment.deliveryDate','Delivery Date'], ['booksPayment.pyCredit','P.Y. Credit'], ['booksPayment.discount','Discount'], ['booksPayment.spInvoiceValueMo','SP Invoice Value (MO)'], ['booksPayment.spInvoiceValueAdditionalOrders','SP Invoice Value (AO)'], ['booksPayment.total2526','25-26 Total'], ['booksPayment.amountReceived','Amount Received'], ['booksPayment.amountReceivedDate','Amount Received Date'], ['booksPayment.amountPending','Amount Pending'], ['booksPayment.status','Status'], ['booksPayment.remarks','Comments']]],
  ['Deliverables 1', [['deliverables1.teachersCopy','Teachers Copy — Count'], ['deliverables1.teachersCopyDate','Teachers Copy — Date'], ['deliverables1.teachersManual1','Teachers Manual — Count'], ['deliverables1.teachersManual1Date','Teachers Manual — Date'], ['deliverables1.teachersManual2','Teachers Manual 2 — Count'], ['deliverables1.teachersManual2Date','Teachers Manual 2 — Date'], ['deliverables1.flashCards','Flash Card — Count'], ['deliverables1.flashCardsDate','Flash Card — Date']]],
  ['Deliverables 2', [['deliverables2.whatsapp','WhatsApp — Count'], ['deliverables2.whatsappDate','WhatsApp — Date'], ['deliverables2.windowsApp.appVersion','Windows App — Version'], ['deliverables2.windowsApp.date','Windows App — Date'], ['deliverables2.windowsApp.lkg','Windows App — LKG'], ['deliverables2.windowsApp.ukg','Windows App — UKG'], ['deliverables2.windowsApp.systemTvBoth','Windows App — System / TV / Both'], ['deliverables2.kidsApp.appVersion','Kids App — Count / Version'], ['deliverables2.kidsApp.date','Kids App — Date'], ['deliverables2.kidsApp.systemTvBoth','Kids App — System / TV / Both'], ['deliverables2.appComments','Windows App Comments']]],
  ['Deliverables 3', [['deliverables3.questionPaper','Question Paper — Count'], ['deliverables3.questionPaperDate','Question Paper — Date'], ['deliverables3.progressCard','Progress Card — Count'], ['deliverables3.progressCardDate','Progress Card — Date']]],
  ['Services', [['services.t1','T1'], ['services.atu1','ATU 1'], ['services.atu1Date','ATU 1 — Date'], ['services.atu1Comments','ATU 1 — Comments'], ['services.sim1','SIM 1'], ['services.sim1Date','SIM 1 — Date'], ['services.sim1Comments','SIM 1 — Comments'], ['services.t2','T2'], ['services.atu2','ATU 2'], ['services.atu2Date','ATU 2 — Date'], ['services.atu2Comments','ATU 2 — Comments'], ['services.sim2','SIM 2'], ['services.sim2Date','SIM 2 — Date'], ['services.sim2Comments','SIM 2 — Comments'], ['services.t3','T3'], ['services.sim3','SIM 3'], ['services.sim3Date','SIM 3 — Date'], ['services.sim3Comments','SIM 3 — Comments']]],
  ['Current status', [['currentStatus','Current Status'], ['comments','Comments']]],
];
function getPath(obj, path) { return path.split('.').reduce((v,k) => v?.[k], obj) ?? ''; }
function setPath(obj, path, value) { const keys=path.split('.'); const out={...obj}; let cur=out; keys.slice(0,-1).forEach(k=>{ cur[k]={...(cur[k]||{})}; cur=cur[k]; }); cur[keys[keys.length-1]]=value; return out; }
function formatHistoryValue(path, value) {
  const raw=String(value ?? '').trim();
  if(!raw) return '';
  if(path === 'booksPayment.discount' && /^[-+]?\d*\.?\d+$/.test(raw)){
    const n=Number(raw);
    if(Number.isFinite(n) && n >= 0 && n <= 1) return `${(n * 100).toFixed(2).replace(/\.?0+$/,'')}%`;
  }
  return raw;
}

function readU16(view, offset) { return view.getUint16(offset, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }

async function unzipEntry(buffer, entry) {
  const view = new DataView(buffer);
  const local = entry.localOffset;
  if (readU32(view, local) !== 0x04034b50) throw new Error('Invalid Excel file.');
  const nameLen = readU16(view, local + 26), extraLen = readU16(view, local + 28);
  const start = local + 30 + nameLen + extraLen;
  const compressed = buffer.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return new Uint8Array(compressed);
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read this Excel file.');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([compressed]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readXlsxFiles(file) {
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Please choose an .xlsx Excel file.');
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (readU32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The Excel file could not be read.');
  const count = readU16(view, eocd + 10), cdSize = readU32(view, eocd + 12), cdOffset = readU32(view, eocd + 16);
  const entries = new Map(); let off = cdOffset;
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (readU32(view, off) !== 0x02014b50) throw new Error('Invalid Excel archive.');
    const method = readU16(view, off + 10), compressedSize = readU32(view, off + 20), nameLen = readU16(view, off + 28), extraLen = readU16(view, off + 30), commentLen = readU16(view, off + 32), localOffset = readU32(view, off + 42);
    const name = decoder.decode(bytes.slice(off + 46, off + 46 + nameLen));
    entries.set(name, { method, compressedSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const get = async (name) => {
    const entry = entries.get(name); if (!entry) return null;
    return new TextDecoder().decode(await unzipEntry(buffer, entry));
  };
  const sharedXml = await get('xl/sharedStrings.xml');
  const shared = sharedXml ? Array.from(new DOMParser().parseFromString(sharedXml,'application/xml').querySelectorAll('si')).map(si => Array.from(si.querySelectorAll('t')).map(t=>t.textContent).join('')) : [];

  // Resolve the worksheet by workbook metadata instead of assuming Sheet1.
  // Real school files often have an extra cover/instructions sheet first.
  const workbookXml = await get('xl/workbook.xml');
  const relsXml = await get('xl/_rels/workbook.xml.rels');
  const workbookDoc = workbookXml ? new DOMParser().parseFromString(workbookXml,'application/xml') : null;
  const relsDoc = relsXml ? new DOMParser().parseFromString(relsXml,'application/xml') : null;
  const relMap = {};
  relsDoc?.querySelectorAll('Relationship').forEach(r => relMap[r.getAttribute('Id')] = r.getAttribute('Target'));
  const sheets = Array.from(workbookDoc?.querySelectorAll('sheet') || []);
  let chosen = null;
  for (const sh of sheets) {
    const name = normExcel(sh.getAttribute('name'));
    const target = relMap[sh.getAttribute('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')] || relMap[sh.getAttribute('r:id')];
    const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\//,'')}`) : '';
    if (/school\s*name|school\s*history/i.test(name) || /school\s*history/i.test(path)) { chosen = { name, path }; break; }
  }
  if (!chosen) {
    const sh = sheets[0];
    const target = sh ? (relMap[sh.getAttribute('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')] || relMap[sh.getAttribute('r:id')]) : null;
    chosen = { name: normExcel(sh?.getAttribute('name') || 'Sheet1'), path: target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml' };
  }
  const sheetXml = await get(chosen.path || 'xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error('The School History worksheet could not be read.');
  const doc = new DOMParser().parseFromString(sheetXml,'application/xml');
  const cells = {};
  doc.querySelectorAll('sheetData > row > c').forEach(c => {
    const ref = c.getAttribute('r'); const type = c.getAttribute('t'); const v = c.querySelector('v'); const inline = c.querySelector('is');
    let value = inline ? Array.from(inline.querySelectorAll('t')).map(t=>t.textContent).join('') : (v?.textContent || '');
    if (type === 's') value = shared[Number(value)] ?? '';
    if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
    cells[ref] = String(value).trim();
  });
  return { cells, sheetName: chosen.name };
}

const excelText = (cells, ref) => String(cells[ref] ?? '').trim();
const normExcel = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const labelValue = (value, label) => normExcel(value).replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), '').trim();
const excelDateText = (value) => {
  const raw = normExcel(value);
  if (!raw) return '';
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;
    }
  }
  return raw;
};
const splitContact = (value) => {
  const raw = normExcel(value);
  const phone = (raw.match(/(?:\+?\d[\d\s().-]{7,}\d)/) || [])[0] || '';
  const name = phone ? raw.replace(phone, '').replace(/[|–—-]+\s*$/,'').trim() : raw;
  return { name, phone: phone.trim() };
};

// The School History workbook is a form, not a database export. In real files
// users may insert rows, move columns, or have merged cells. Therefore the
// importer is label/header driven: it finds the row containing a field name,
// then reads the value under the matching header. It does NOT rely on a fixed
// "B19 means Teachers Copy" assumption. This prevents values such as STATUS or
// another row's date from being attached to the preceding field.
function importSchoolHistoryTemplate(cells, current) {
  // Excel import is a replacement: clear fields from previous bad imports first.
  const out = {
    location:'', vintage:'', books:'', category:'',
    contacts:{correspondent:'',correspondentPhone:'',principal:'',principalPhone:'',keyPerson:'',keyPersonPhone:''},
    booksPayment:{lkg:'',lkgAdditionalOrders:'',lkgReturns:'',lkgRemarks:'',ukg:'',ukgAdditionalOrders:'',ukgReturns:'',ukgRemarks:'',lkgHhp:'',ukgHhp:'',deliveryDate:'',pyCredit:'',discount:'',discountAdditionalOrders:'',discountReturns:'',discountRemarks:'',spInvoiceValueMo:'',spInvoiceValue2526:'',spInvoiceValueAdditionalOrders:'',total2526:'',amountReceived:'',amountReceivedDate:'',amountPending:'',status:'',remarks:''},
    deliverables1:{teachersCopy:'',teachersCopyDate:'',teachersManual1:'',teachersManual1Date:'',teachersManual2:'',teachersManual2Date:'',flashCards:'',flashCardsDate:''},
    deliverables2:{whatsapp:'',whatsappDate:'',windowsApp:{appVersion:'',date:'',lkg:'',ukg:'',systemTvBoth:''},kidsApp:{appVersion:'',date:'',lkg:'',ukg:'',systemTvBoth:''},appComments:''},
    deliverables3:{questionPaper:'',questionPaperDate:'',progressCard:'',progressCardDate:''},
    services:{t1:'',atu1:'',atu1Date:'',atu1Comments:'',sim1:'',sim1Date:'',sim1Comments:'',t2:'',atu2:'',atu2Date:'',atu2Comments:'',sim2:'',sim2Date:'',sim2Comments:'',t3:'',sim3:'',sim3Date:'',sim3Comments:''},
    currentStatus:'', comments:''
  };
  const entries=Object.entries(cells).map(([ref,value])=>{const m=ref.match(/^([A-Z]+)(\d+)$/);if(!m)return null;let col=0;for(const ch of m[1])col=col*26+ch.charCodeAt(0)-64;return{ref,row:Number(m[2]),col,value:normExcel(value)};}).filter(Boolean);
  const rows=new Map(); for(const x of entries){if(!rows.has(x.row))rows.set(x.row,[]);rows.get(x.row).push(x);} for(const r of rows.values())r.sort((a,b)=>a.col-b.col);
  const clean=v=>normExcel(v).replace(/[：:]$/,'').replace(/\s+/g,' ').trim().toLowerCase();
  const rowWith=label=>{for(const [r,xs] of rows)if(xs.some(x=>clean(x.value)===clean(label)))return r;return null;};
  const lastRowWith=label=>{let hit=null;for(const [r,xs] of rows)if(xs.some(x=>clean(x.value)===clean(label)))hit=r;return hit;};
  const cell=(r,c)=>r?((rows.get(r)||[]).find(x=>x.col===c)?.value||''):'';
  const put=(path,value,date=false)=>{let v=normExcel(value);if(date)v=excelDateText(v);if(!v||v==='-'||v==='—')return;const ks=path.split('.');let o=out;for(const k of ks.slice(0,-1))o=o[k];o[ks.at(-1)]=v;};
  const inline=(v,label)=>normExcel(v).replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\s*[:：]\\s*`,'i'),'').trim();

  // Basic details: support combined LABEL: VALUE cells and split LABEL | VALUE cells.
  for(const [label,key] of [['LOCATION','location'],['VINTAGE','vintage'],['BOOKS','books'],['CATEGORY','category']]){
    const row=rows.get(3)||[];
    const x=row.find(c=>new RegExp(`^${label}\\s*[:：]\\s*(.+)$`, 'i').test(c.value));
    if(x){ put(key,inline(x.value,label)); continue; }
    const labelCell=row.find(c=>new RegExp(`^${label}\\s*[:：]?$`, 'i').test(c.value));
    const next=labelCell && row.find(c=>c.col>labelCell.col && normExcel(c.value));
    if(next && !/^(LOCATION|VINTAGE|BOOKS|CATEGORY)\s*[:：]?/i.test(next.value)) put(key,normExcel(next.value).replace(/^[:：]\s*/,''));
  }
  const schoolName=(rows.get(2)||[]).map(x=>x.value).find(Boolean)||'';

  // Contacts: role in A, person in B, phone in C. Preserve nil/blank as blank.
  for(const [label,key,phoneKey] of [['CORRESPONDENT','correspondent','correspondentPhone'],['PRINCIPAL','principal','principalPhone'],['KEY PERSON','keyPerson','keyPersonPhone']]){
    const r=rowWith(label);if(!r)continue;put(`contacts.${key}`,cell(r,2));const ph=cell(r,3);if(/\d{7,}/.test(ph))put(`contacts.${phoneKey}`,ph);
  }

  // Books & Payment — explicit row identity and explicit source columns.
  for(const [label,key] of [['LKG','lkg'],['UKG','ukg']]){const r=rowWith(label);if(r){put(`booksPayment.${key}`,cell(r,2));put(`booksPayment.${key}AdditionalOrders`,cell(r,3));put(`booksPayment.${key}Returns`,cell(r,4));}}
  put('booksPayment.lkgHhp',cell(rowWith('LKG - HHP'),2)); put('booksPayment.ukgHhp',cell(rowWith('UKG - HHP'),2));
  const del=rowWith('DELIVERY DATE');if(del){put('booksPayment.deliveryDate',cell(del,2),true);put('booksPayment.pyCredit',cell(del,5));}
  put('booksPayment.discount',cell(rowWith('DISCOUNT'),2));
  const inv=rowWith('SP INVOICE VALUE (MO)');if(inv){put('booksPayment.spInvoiceValueMo',cell(inv,2));put('booksPayment.total2526',cell(inv,6));}
  const ao=rowWith('SP INVOICE VALUE (AO)');if(ao)put('booksPayment.spInvoiceValueAdditionalOrders',cell(ao,4));
  const rec=rowWith('AMOUNT RECEIVED');if(rec){put('booksPayment.amountReceived',cell(rec,2));put('booksPayment.amountReceivedDate',cell(rec,4),true);}
  const pend=rowWith('AMOUNT PENDING');if(pend){put('booksPayment.amountPending',cell(pend,2));put('booksPayment.status',cell(pend,4));}
  // Row 20 is the Books & Payment comments line; keep it separate from the final school comment.
  const bpCommentRow=rows.get(20)?.some(x=>clean(x.value)==='comments') ? 20 : null;
  if(bpCommentRow)put('booksPayment.remarks',cell(bpCommentRow,2));

  // Deliverables 1 — exact rows and B=Count, C=Date.
  for(const [label,key] of [['Teachers Copy','teachersCopy'],['Teachers Manual','teachersManual1'],['Teachers Manual 1','teachersManual1'],['Teachers Manual 2','teachersManual2'],['Flash Card','flashCards'],['Flash Cards','flashCards']]){const r=rowWith(label);if(r){put(`deliverables1.${key}`,cell(r,2));put(`deliverables1.${key}Date`,cell(r,3),true);}}

  // Deliverables 2 — exact rows. Windows App Comments has its own row.
  const wa=rowWith('WhatsApp');if(wa){put('deliverables2.whatsapp',cell(wa,2));put('deliverables2.whatsappDate',cell(wa,3),true);}
  const win=rowWith('Windows App');if(win){put('deliverables2.windowsApp.appVersion',cell(win,2));put('deliverables2.windowsApp.date',cell(win,3),true);put('deliverables2.windowsApp.lkg',cell(win,4));put('deliverables2.windowsApp.ukg',cell(win,5));put('deliverables2.windowsApp.systemTvBoth',cell(win,6));}
  const kids=rowWith('Kids App');if(kids){put('deliverables2.kidsApp.appVersion',cell(kids,2));put('deliverables2.kidsApp.date',cell(kids,3),true);put('deliverables2.kidsApp.systemTvBoth',cell(kids,4));}
  const wc=rowWith('Windows App Comments');if(wc)put('deliverables2.appComments',cell(wc,2));

  for(const [label,key] of [['Question Paper','questionPaper'],['Progress Card','progressCard']]){const r=rowWith(label);if(r){put(`deliverables3.${key}`,cell(r,2));put(`deliverables3.${key}Date`,cell(r,3),true);}}

  // Services — retain name/value, date and every dedicated comment row.
  for(const [label,key] of [['T1','t1'],['ATU 1','atu1'],['SIM 1','sim1'],['T2','t2'],['ATU 2','atu2'],['SIM 2','sim2'],['T3','t3'],['SIM 3','sim3']]){const r=rowWith(label);if(r){put(`services.${key}`,cell(r,2));if(/^(atu1|sim1|atu2|sim2|sim3)$/.test(key))put(`services.${key}Date`,cell(r,3),true);}}
  for(const [label,key] of [['ATU 1 COMMENTS','atu1Comments'],['SIM 1 COMMENTS','sim1Comments'],['ATU 2 COMMENTS','atu2Comments'],['SIM 2 COMMENTS','sim2Comments'],['SIM 3 COMMENTS','sim3Comments']]){const r=rowWith(label);if(r)put(`services.${key}`,cell(r,2));}
  put('currentStatus',cell(rowWith('CURRENT STATUS'),2));
  // The final COMMENTS row is after CURRENT STATUS. Using the last matching row avoids
  // accidentally reading the blank Books & Payment comments row.
  put('comments',cell(lastRowWith('COMMENTS'),2));
  return {out,schoolName};
}
function SchoolHistoryCard({ T, api, school, editing, setEditing, M, Btn, onSaved, isPhone }) {
  const [busy,setBusy]=useState(false); const [problem,setProblem]=useState(null); const [importing,setImporting]=useState(false); const [commentPopup,setCommentPopup]=useState(null);
  const initial=school.school_history || {};
  const [draft,setDraft]=useState(initial);
  useEffect(()=>{ if(!editing) setDraft(school.school_history || {}); },[school.school_history,editing]);
  const save=async()=>{setBusy(true);setProblem(null);try{const out=await api.admin.updateSchoolHistory(school.location_id,draft,newActionKey());setEditing(false);onSaved?.(out?.school_history || draft);}catch(e){setProblem(e);}finally{setBusy(false);}};
  const importExcel=async(e)=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;setImporting(true);setProblem(null);try{const {cells}=await readXlsxFiles(file);const imported=importSchoolHistoryTemplate(cells,draft);const excelSchool=imported.schoolName;if(excelSchool && excelSchool.toLowerCase().replace(/\s+/g,' ')!==school.name.toLowerCase().replace(/\s+/g,' ')){throw new Error(`This Excel file is for “${excelSchool}”, but you are editing “${school.name}”.`);}setDraft(imported.out);}catch(err){setProblem({message:err.message || 'Could not import that Excel file.'});}finally{setImporting(false);}};
  const filled=historySections.flatMap(([,fields])=>fields).filter(([path])=>String(getPath(initial,path)).trim()).length;
  const contactItems=[['Correspondent','contacts.correspondent','contacts.correspondentPhone'],['Principal','contacts.principal','contacts.principalPhone'],['Key Person','contacts.keyPerson','contacts.keyPersonPhone']].map(([label,n,p])=>({label,name:String(getPath(initial,n)).trim(),phone:String(getPath(initial,p)).trim()})).filter(x=>x.name||x.phone);
  return <div style={{position:'relative',marginBottom:isPhone?24:40,padding:isPhone?12:18,border:`1px solid ${T.line}`,borderRadius:12,background:T.sub,overflow:'hidden'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}><div><div className="mono" style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.12em',color:T.faint}}>School History</div><M style={{fontSize:12,color:T.mute,display:'block',marginTop:5}}>2025–2026 · {filled} details recorded</M></div><button className="press" title="Edit school history" aria-label="Edit school history" onClick={()=>{setDraft(initial);setProblem(null);setEditing(true)}} style={{width:36,height:36,borderRadius:9,border:`1px solid ${T.line}`,background:T.bg,color:T.text,cursor:'pointer',fontSize:17}}>✎</button></div>
    {!filled ? <M style={{fontSize:13,color:T.mute}}>No history details entered yet. Use the corner edit button to add the school record.</M> : historySections.map(([title,fields])=>{
      const vals=fields.map(([path,label])=>[path,label,String(getPath(initial,path)).trim()]).filter(([, ,v])=>v);
      if(!vals.length)return null;
      return <div key={title} style={{borderTop:`1px solid ${T.line}`,paddingTop:12,marginTop:12}}>
        <div style={{fontSize:12,fontWeight:600,marginBottom:8}}>{title}</div>
        {title==='Contacts' ? <div style={{display:'grid',gap:2}}>
          {contactItems.map((x,i)=><div key={i} style={{display:'grid',gridTemplateColumns:isPhone?'34% 66%':'190px 1fr',gap:isPhone?8:12,alignItems:'center',padding:'7px 0',fontSize:isPhone?12:12}}>
            <span style={{color:T.faint}}>{x.label}</span>
            <div style={{minWidth:0,display:'flex',alignItems:'center',gap:8}}>
              <span style={{color:T.text,whiteSpace:'pre-wrap',overflowWrap:'anywhere',flex:1}}>{x.name || '—'}{x.phone && <><span style={{color:T.mute}}> · </span><a className="press" href={`tel:${x.phone.replace(/[^+\d]/g,'')}`} aria-label={`Call ${x.label} ${x.phone}`} style={{color:T.text,textDecoration:'underline',textUnderlineOffset:3}}>{x.phone}</a></>}</span>
            </div>
          </div>)}
        </div> : title==='Services' ? <div style={{display:'grid',gap:2}}>
          {[
            ['ATU 1','services.atu1','services.atu1Comments'],
            ['SIM 1','services.sim1','services.sim1Comments'],
            ['ATU 2','services.atu2','services.atu2Comments'],
            ['SIM 2','services.sim2','services.sim2Comments'],
            ['SIM 3','services.sim3','services.sim3Comments'],
          ].map(([label,path,commentPath])=>{
            const value=String(getPath(initial,path)).trim();
            const comment=String(getPath(initial,commentPath)).trim();
            if(!value && !comment)return null;
            return <div key={path} style={{display:'grid',gridTemplateColumns:isPhone?'48% 52%':'190px 1fr',gap:isPhone?8:12,alignItems:'center',padding:'6px 0',fontSize:12,minWidth:0}}>
              <span style={{color:T.faint,lineHeight:1.35}}>{label}</span>
              <div style={{minWidth:0}}>
                {comment ? <button type="button" className="press" onClick={()=>setCommentPopup({title:label,comment})} aria-label={`Open ${label} comments`} style={{display:'block',width:'100%',padding:0,border:0,background:'none',color:T.text,textAlign:'left',font:'inherit',cursor:'pointer',lineHeight:1.35,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{value || 'View comments'}</button> : <span style={{color:T.text,lineHeight:1.35,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',display:'block'}}>{value || '—'}</span>}
              </div>
            </div>;
          })}
        </div> : <div style={{display:'grid',gap:2}}>
          {vals.map(([path,label,rawValue])=>{
            const value=formatHistoryValue(path,rawValue);
            const numeric=/^[+\-₹$€£]?\s*\d[\d,./%+\- ]*$/.test(value);
            const isComment=/comments|remarks|appComments/i.test(label);
            return <div key={path} style={{display:'grid',gridTemplateColumns:isPhone?'48% 52%':'190px 1fr',gap:isPhone?8:12,alignItems:'start',padding:'6px 0',fontSize:isPhone?12:12,minWidth:0}}>
              <span style={{color:T.faint,lineHeight:1.35,overflowWrap:'anywhere'}}>{label}</span>
              <span style={{color:T.text,lineHeight:1.35,whiteSpace:numeric?'nowrap':'pre-wrap',overflowWrap:'anywhere',textAlign:numeric?'right':'left',fontVariantNumeric:numeric?'tabular-nums':undefined}}>{isComment && isPhone && value.length>120 ? <button type="button" className="press" onClick={()=>setCommentPopup({title:label,comment:value})} style={{display:'block',width:'100%',padding:0,border:0,background:'none',color:T.text,textAlign:'left',font:'inherit',cursor:'pointer',lineHeight:1.35,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{value}</button> : value}</span>
            </div>;
          })}
        </div>}
      {commentPopup && <div className="fade" role="dialog" aria-modal="true" aria-label={`${commentPopup.title} comments`} onClick={()=>setCommentPopup(null)} style={{position:'fixed',inset:0,zIndex:120,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}><div className="rise" onClick={e=>e.stopPropagation()} style={{width:'100%',maxWidth:420,maxHeight:isPhone?'70vh':'60vh',overflowY:'auto',background:T.bg,border:`1px solid ${T.line}`,borderRadius:12,padding:16,boxSizing:'border-box',boxShadow:'0 12px 40px rgba(0,0,0,.18)'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,marginBottom:10}}><div style={{fontSize:14,fontWeight:600}}>{commentPopup.title} — Comments</div><button type="button" className="press" onClick={()=>setCommentPopup(null)} aria-label="Close comments" style={{width:30,height:30,borderRadius:7,border:`1px solid ${T.line}`,background:'transparent',color:T.text,cursor:'pointer',fontSize:18}}>×</button></div><div style={{fontSize:13,lineHeight:1.55,color:T.text,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{commentPopup.comment}</div></div></div>}
      </div>
    })}
    {editing && <div className="fade" style={{position:'fixed',inset:0,zIndex:80,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}><div className="rise" style={{width:'100%',maxWidth:720,maxHeight:'92vh',overflowY:'auto',background:T.bg,border:`1px solid ${T.line}`,borderRadius:14,padding:22}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><div><div className="tight" style={{fontSize:20,fontWeight:600}}>Edit School History</div><M style={{fontSize:12,color:T.mute}}>{school.name} · 2025–2026</M></div><button onClick={()=>setEditing(false)} style={{background:'none',border:'none',color:T.faint,fontSize:20,cursor:'pointer'}}>×</button></div>
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:18,flexWrap:'wrap'}}><label className="press" style={{display:'inline-flex',alignItems:'center',gap:7,padding:'8px 12px',borderRadius:8,border:`1px solid ${T.line}`,cursor:importing?'wait':'pointer',fontSize:12,color:T.text}}><span>Import Excel</span><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importExcel} disabled={importing} style={{display:'none'}}/></label><span style={{fontSize:12,color:T.faint}}>Imports the supplied 2025–2026 School History format and fills the form. You can edit anything before saving.</span></div>
      {historySections.map(([title,fields])=><div key={title} style={{marginBottom:22}}><div className="mono" style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.12em',color:T.faint,marginBottom:10}}>{title}</div><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}}>{fields.map(([path,label])=><div key={path} style={{gridColumn:/comments|remarks|appComments/i.test(label)?'1 / -1':undefined}}><label style={{fontSize:11,color:T.mute,display:'block',marginBottom:5}}>{label}</label>{/comments|remarks/i.test(label)?<textarea rows={3} value={getPath(draft,path)} onChange={e=>setDraft(setPath(draft,path,e.target.value))} style={{width:'100%',boxSizing:'border-box',padding:'9px 10px',borderRadius:8,border:`1px solid ${T.line}`,background:'transparent',color:T.text,fontFamily:'inherit',resize:'vertical'}}/>:<input value={getPath(draft,path)} onChange={e=>setDraft(setPath(draft,path,e.target.value))} style={{width:'100%',boxSizing:'border-box',padding:'9px 10px',borderRadius:8,border:`1px solid ${T.line}`,background:'transparent',color:T.text,outline:'none'}}/>}</div>)}</div></div>)}
      {problem&&<div style={{color:T.accent,fontSize:13,marginBottom:12}}>{problem.message}</div>}<div style={{display:'flex',gap:8}}><Btn variant="line" onClick={()=>setEditing(false)}>Cancel</Btn><Btn busy={busy} onClick={save}>{busy?'Saving…':'Save History'}</Btn></div>
    </div></div>}
  </div>;
}

function parseGoogleMapsLocation(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let text = raw;
  try { text = decodeURIComponent(raw); } catch { /* keep original */ }

  // IMPORTANT: Google Maps @lat,lng is usually the map viewport center,
  // not the actual place pin. For a Google Maps place URL, the !3d...!4d...
  // pair is the place coordinate and must win.
  const place = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i);
  if (place) {
    const latitude = Number(place[1]);
    const longitude = Number(place[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      return { latitude: latitude.toFixed(6), longitude: longitude.toFixed(6) };
    }
  }

  // These are safe coordinate-bearing forms when they are explicitly a
  // query/destination, rather than a map viewport.
  const query = text.match(/[?&](?:q|query|ll|destination)=\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (query) {
    const latitude = Number(query[1]);
    const longitude = Number(query[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      return { latitude: latitude.toFixed(6), longitude: longitude.toFixed(6) };
    }
  }

  // Do NOT use /@lat,lng/ for Google Maps links: it can be only the viewport.
  // It is intentionally left to the server resolver, which follows short
  // links and extracts the final place coordinate.
  return null;
}

function isGoogleMapsUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    const host = u.hostname.toLowerCase();
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'google.com'
        || host === 'www.google.com' || host === 'maps.google.com')
      : false;
  } catch {
    return false;
  }
}

function SchoolForm({ T, api, school, onClose, onDone, isPhone, Btn }) {
  const editing = !!school;
  const [f, setF] = useState({
    name: school?.name || '',
    zone: school?.zone || '',
    address: school?.address || '',
    contactPerson: school?.contact_person || '',
    contactDesignation: school?.contact_designation || '',
    contactPhone: school?.contact_phone || '',
    latitude: school?.latitude ?? '',
    longitude: school?.longitude ?? '',
    radiusMetres: school?.radius_metres ?? 100,
    isActive: school ? school.is_active : true,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [resolvingMaps, setResolvingMaps] = useState(false);
  const [manualLocation, setManualLocation] = useState(false);
  const [mapsUrl, setMapsUrl] = useState(() => (school?.latitude !== null && school?.longitude !== null) ? `https://www.google.com/maps/search/?api=1&query=${school.latitude},${school.longitude}` : '');
  const set = (patch) => { setF({ ...f, ...patch }); setProblem(null); };
  const applyMapsLocation = async (value) => {
    const raw = String(value || '').trim();
    if (!raw) { setMapsUrl(''); set({ latitude: '', longitude: '' }); return true; }

    if (!isGoogleMapsUrl(raw)) {
      setProblem(new Error('Paste a Google Maps link, or enter latitude and longitude manually.'));
      return false;
    }

    // Always resolve Google Maps links on the server. This is important because
    // /@lat,lng/ can be a viewport center and can differ from the school pin.
    setMapsUrl(raw);
    setResolvingMaps(true);
    setProblem(null);
    try {
      const result = await api.admin.resolveGoogleMaps(raw);
      const coords = { latitude: Number(result.latitude).toFixed(6), longitude: Number(result.longitude).toFixed(6) };
      setF(prev => ({ ...prev, ...coords }));
      return true;
    } catch (e) {
      setProblem(e);
      return false;
    } finally {
      setResolvingMaps(false);
    }
  };

  const lat = Number(f.latitude), lng = Number(f.longitude), radius = Number(f.radiusMetres);
  // Coordinates are optional: a school is usually known before anyone has
  // stood at the gate. But half a coordinate would look set and match
  // nothing, so it is both or neither.
  const blank = String(f.latitude).trim() === '' && String(f.longitude).trim() === '';
  const latOk = blank || (Number.isFinite(lat) && lat >= -90 && lat <= 90 && String(f.latitude).trim() !== '');
  const lngOk = blank || (Number.isFinite(lng) && lng >= -180 && lng <= 180 && String(f.longitude).trim() !== '');
  const radiusOk = Number.isInteger(radius) && radius >= 20 && radius <= 2000;
  const incomplete = !f.name.trim() || !f.zone.trim() || !latOk || !lngOk || !radiusOk;

  const submit = async () => {
    setBusy(true); setProblem(null);
    const body = {
      name: f.name.trim(), zone: f.zone.trim(),
      ...(f.address.trim() ? { address: f.address.trim() } : {}),
      ...(f.contactPerson.trim() ? { contactPerson: f.contactPerson.trim() } : {}),
      ...(f.contactDesignation.trim() ? { contactDesignation: f.contactDesignation.trim() } : {}),
      ...(f.contactPhone.trim() ? { contactPhone: f.contactPhone.trim() } : {}),
      latitude: blank ? null : lat, longitude: blank ? null : lng,
      radiusMetres: radius, isActive: f.isActive,
    };
    try {
      if (editing) await api.admin.updateSchool(school.location_id, body, newActionKey());
      else await api.admin.createSchool(body, newActionKey());
      onDone();
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
  const bad = { ...field, borderColor: T.accent };

  return (
    <div className="fade" style={{
      position: 'fixed', inset: 0, background: T.overlay, zIndex: 60, display: 'flex',
      alignItems: isPhone ? 'flex-end' : 'center', justifyContent: 'center', padding: isPhone ? 0 : 16,
    }}>
      <div className="rise" style={{
        width: '100%', maxWidth: 520, background: T.bg, padding: 28,
        borderRadius: isPhone ? '16px 16px 0 0' : 16, border: `1px solid ${T.line}`,
        maxHeight: '92vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
          <div className="tight" style={{ fontSize: 18, fontWeight: 600 }}>
            {editing ? 'Edit school' : 'Add school'}
          </div>
          <button className="press" onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="mono" style={label}>School name</div>
          <input value={f.name} autoFocus onChange={(e) => set({ name: e.target.value })}
            placeholder="ABC Matriculation School" style={field} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 20 }}>
          <div>
            <div className="mono" style={label}>Zone</div>
            <input value={f.zone} onChange={(e) => set({ zone: e.target.value })}
              placeholder="Thiruporur" style={field} />
          </div>
          <div>
            <div className="mono" style={label}>Radius (metres)</div>
            <input type="number" value={f.radiusMetres} onChange={(e) => set({ radiusMetres: e.target.value })}
              className="mono" style={radiusOk || f.radiusMetres === '' ? field : bad} />
            {!radiusOk && f.radiusMetres !== '' && (
              <div style={{ fontSize: 12, color: T.accent, marginTop: 6 }}>Between 20 and 2000 metres.</div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="mono" style={label}>Address</div>
          <textarea value={f.address} rows={2} onChange={(e) => set({ address: e.target.value })}
            placeholder="Optional" style={{ ...field, resize: 'vertical' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 20 }}>
          <div>
            <div className="mono" style={label}>Contact person</div>
            <input value={f.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })}
              placeholder="Optional" style={field} />
          </div>
          <div>
            <div className="mono" style={label}>Designation</div>
            <input value={f.contactDesignation} onChange={(e) => set({ contactDesignation: e.target.value })}
              placeholder="Principal" style={field} />
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <div className="mono" style={label}>Contact phone</div>
          <input value={f.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })}
            placeholder="Optional" className="mono" style={field} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <div className="mono" style={label}>Location</div>
          {!manualLocation ? <>
            <input
              value={mapsUrl}
              onChange={(e) => {
                const value = e.target.value;
                setMapsUrl(value);
                if (!value.trim()) set({ latitude: '', longitude: '' });
              }}
              onBlur={() => { if (mapsUrl.trim()) applyMapsLocation(mapsUrl); }}
              onPaste={(e) => {
                const value = e.clipboardData?.getData('text') || '';
                e.preventDefault();
                setMapsUrl(value);
                applyMapsLocation(value);
              }}
              disabled={resolvingMaps}
              placeholder="Paste Google Maps link here"
              style={field}
            />
            <div style={{ fontSize: 12, color: T.mute, lineHeight: 1.6, marginTop: 8 }}>
              {resolvingMaps ? 'Resolving Google Maps link…' : 'Paste a Google Maps link, including maps.app.goo.gl short links.'}
            </div>
            <button type="button" className="press" onClick={() => { setManualLocation(true); setMapsUrl(''); }}
              style={{ marginTop: 10, padding: 0, border: 0, background: 'none', color: T.text, textDecoration: 'underline', cursor: 'pointer', font: 'inherit', fontSize: 12 }}>
              Enter latitude and longitude manually instead
            </button>
          </> : <>
            <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: T.mute, marginBottom: 5 }}>Latitude</div>
                <input value={f.latitude} onChange={(e) => set({ latitude: e.target.value })} placeholder="13.119008" inputMode="decimal" style={field} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: T.mute, marginBottom: 5 }}>Longitude</div>
                <input value={f.longitude} onChange={(e) => set({ longitude: e.target.value })} placeholder="80.261181" inputMode="decimal" style={field} />
              </div>
            </div>
            <button type="button" className="press" onClick={() => setManualLocation(false)}
              style={{ marginTop: 10, padding: 0, border: 0, background: 'none', color: T.text, textDecoration: 'underline', cursor: 'pointer', font: 'inherit', fontSize: 12 }}>
              Use Google Maps link instead
            </button>
          </>}
          {f.latitude !== '' && f.longitude !== '' && (
            <div className="mono" style={{ fontSize: 11, color: T.faint, marginTop: 8 }}>
              Position: {f.latitude}, {f.longitude}
            </div>
          )}
        </div>

        {editing && (
          <div style={{ paddingTop: 20, borderTop: `1px solid ${T.line}`, marginBottom: 20 }}>
            <button className="press" onClick={() => set({ isActive: !f.isActive })}
              style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', color: T.text }}>
              <span style={{
                width: 34, height: 20, borderRadius: 999, position: 'relative', flexShrink: 0,
                background: f.isActive ? T.text : T.line, transition: 'background .18s',
              }}>
                <span style={{
                  position: 'absolute', width: 14, height: 14, borderRadius: '50%', top: 3,
                  left: f.isActive ? 17 : 3, background: T.bg, transition: 'left .18s cubic-bezier(.2,.8,.3,1)',
                }} />
              </span>
              <span>
                <span style={{ fontSize: 14, display: 'block' }}>{f.isActive ? 'Active' : 'Inactive'}</span>
                <span style={{ fontSize: 12, color: T.mute }}>
                  {f.isActive
                    ? 'Assigned employees can punch in here'
                    : 'No new attendance here. Past visits are kept.'}
                </span>
              </span>
            </button>
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
          <Btn full busy={busy} disabled={incomplete} onClick={submit}>
            {editing ? 'Save changes' : 'Add school'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
