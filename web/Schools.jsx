import React, { useState, useMemo, useEffect } from 'react';
import { newActionKey } from './api-client.js';
import { SchoolMap, EvidenceMap, directionsUrl } from './SchoolMap.jsx';

/**
 * Schools — the places trainers visit.
 *
 * Admin only. Employees never see these controls, and the server refuses
 * them regardless of what the interface offers.
 *
 * Sized for roughly 140 schools: a search box and a zone filter over a
 * plain list. No map, no clustering, no virtualised grid.
 */

const istDate = (d) => d ? new Date(d).toLocaleDateString('en-IN',
  { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) : '—';
const istTime = (t) => t ? new Date(t).toLocaleTimeString('en-IN',
  { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';

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
      onEdit={(s) => setEditing(s)} useResource={useResource}
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
    <button className="press" onClick={onBack} style={{
      background: 'none', border: 'none', color: T.mute, fontSize: 12,
      cursor: 'pointer', padding: 0, marginBottom: 24,
    }}>← Schools</button>
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
            <M style={{ fontSize: 14 }}>{s.latitude}, {s.longitude}</M>
            {s.location_set_at && (
              <M style={{ fontSize: 11, color: T.faint, display: 'block', marginTop: 6 }}>
                confirmed {new Date(s.location_set_at).toLocaleDateString('en-IN',
                  { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}
              </M>
            )}
            <a className="press" href={directionsUrl(s, null)} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 13, color: T.text, display: 'inline-block', marginTop: 10 }}>
              Get Directions
            </a>
          </>
        )}
      </div>

      {s.address && (
        <div style={{ marginBottom: 40 }}>
          <div className="mono" style={label}>Address</div>
          <div style={{ fontSize: 14, color: T.mute, lineHeight: 1.6 }}>{s.address}</div>
        </div>
      )}

      <SchoolHistoryCard T={T} api={api} school={s} editing={historyEditing} setEditing={setHistoryEditing} />

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
  ['Basic details', [['vintage','Vintage'], ['books','Books'], ['category','Category']]],
  ['Contacts', [['contacts.correspondent','Correspondent'], ['contacts.principal','Principal'], ['contacts.keyPerson','Key Person']]],
  ['Books & Payment', [['booksPayment.lkg','LKG'], ['booksPayment.ukg','UKG'], ['booksPayment.discount','Discount'], ['booksPayment.spInvoiceValue2526','SP Invoice Value (25-26)'], ['booksPayment.spInvoiceValueAdditionalOrders','SP Invoice Value (Additional Orders)'], ['booksPayment.amountReceived','Amount Received'], ['booksPayment.amountReceivedDate','Amount Received Date'], ['booksPayment.amountPending','Amount Pending'], ['booksPayment.status','Status'], ['booksPayment.remarks','Remarks']]],
  ['Deliverables 1', [['deliverables1.teachersCopy','Teachers Copy'], ['deliverables1.teachersManual1','Teachers Manual 1'], ['deliverables1.teachersManual2','Teachers Manual 2'], ['deliverables1.flashCards','Flash Cards']]],
  ['Deliverables 2', [['deliverables2.whatsapp','WhatsApp'], ['deliverables2.windowsApp.appVersion','Windows App — Version'], ['deliverables2.windowsApp.date','Windows App — Date'], ['deliverables2.windowsApp.lkg','Windows App — LKG'], ['deliverables2.windowsApp.ukg','Windows App — UKG'], ['deliverables2.windowsApp.systemTvBoth','Windows App — System / TV / Both'], ['deliverables2.kidsApp.appVersion','Kids App — Version'], ['deliverables2.kidsApp.date','Kids App — Date'], ['deliverables2.kidsApp.lkg','Kids App — LKG'], ['deliverables2.kidsApp.ukg','Kids App — UKG'], ['deliverables2.kidsApp.systemTvBoth','Kids App — System / TV / Both'], ['deliverables2.appComments','Windows App / Kids App Comments']]],
  ['Deliverables 3', [['deliverables3.questionPaper','Question Paper'], ['deliverables3.progressCard','Progress Card']]],
  ['Services', [['services.t1','T1'], ['services.t2','T2'], ['services.generalVisit','General Visit'], ['services.atu2','ATU 2'], ['services.atu2Comments','ATU 2 Comments'], ['services.sim2','SIM 2'], ['services.sim2Comments','SIM 2 Comments'], ['services.t3','T3'], ['services.sim3','SIM 3'], ['services.sim3Comments','SIM 3 Comments']]],
  ['Current status', [['currentStatus','Current Status'], ['comments','Comments']]],
];
function getPath(obj, path) { return path.split('.').reduce((v,k) => v?.[k], obj) ?? ''; }
function setPath(obj, path, value) { const keys=path.split('.'); const out={...obj}; let cur=out; keys.slice(0,-1).forEach(k=>{ cur[k]={...(cur[k]||{})}; cur=cur[k]; }); cur[keys[keys.length-1]]=value; return out; }

function SchoolHistoryCard({ T, api, school, editing, setEditing }) {
  const [busy,setBusy]=useState(false); const [problem,setProblem]=useState(null);
  const initial=school.school_history || {};
  const [draft,setDraft]=useState(initial);
  useEffect(()=>{ if(!editing) setDraft(school.school_history || {}); },[school.school_history,editing]);
  const save=async()=>{setBusy(true);setProblem(null);try{await api.admin.updateSchoolHistory(school.location_id,draft,newActionKey());setEditing(false);window.location.reload();}catch(e){setProblem(e);}finally{setBusy(false);}};
  const filled=historySections.flatMap(([,fields])=>fields).filter(([path])=>String(getPath(initial,path)).trim()).length;
  return <div style={{position:'relative',marginBottom:40,padding:18,border:`1px solid ${T.line}`,borderRadius:12,background:T.sub}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
      <div><div className="mono" style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.12em',color:T.faint}}>School History</div><M style={{fontSize:12,color:T.mute,display:'block',marginTop:5}}>2025–2026 · {filled} details recorded</M></div>
      <button className="press" title="Edit school history" aria-label="Edit school history" onClick={()=>{setDraft(initial);setProblem(null);setEditing(true)}} style={{width:36,height:36,borderRadius:9,border:`1px solid ${T.line}`,background:T.bg,color:T.text,cursor:'pointer',fontSize:17}}>✎</button>
    </div>
    {!filled ? <M style={{fontSize:13,color:T.mute}}>No history details entered yet. Use the corner edit button to add the school record.</M> : historySections.map(([title,fields])=>{
      const vals=fields.map(([path,label])=>[label,String(getPath(initial,path)).trim()]).filter(([,v])=>v);
      if(!vals.length)return null; return <div key={title} style={{borderTop:`1px solid ${T.line}`,paddingTop:12,marginTop:12}}><div style={{fontSize:12,fontWeight:600,marginBottom:8}}>{title}</div>{vals.map(([label,value])=><div key={label} style={{display:'flex',gap:12,padding:'5px 0',fontSize:12}}><span style={{color:T.faint,minWidth:190}}>{label}</span><span style={{color:T.text,whiteSpace:'pre-wrap'}}>{value}</span></div>)}</div>;
    })}
    {editing && <div className="fade" style={{position:'fixed',inset:0,zIndex:80,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div className="rise" style={{width:'100%',maxWidth:680,maxHeight:'92vh',overflowY:'auto',background:T.bg,border:`1px solid ${T.line}`,borderRadius:14,padding:22}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}><div><div className="tight" style={{fontSize:20,fontWeight:600}}>Edit School History</div><M style={{fontSize:12,color:T.mute}}>{school.name} · 2025–2026</M></div><button onClick={()=>setEditing(false)} style={{background:'none',border:'none',color:T.faint,fontSize:20,cursor:'pointer'}}>×</button></div>
        {historySections.map(([title,fields])=><div key={title} style={{marginBottom:22}}><div className="mono" style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.12em',color:T.faint,marginBottom:10}}>{title}</div><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}}>{fields.map(([path,label])=><div key={path} style={{gridColumn: /comments|remarks|appComments|Comments/i.test(label)?'1 / -1':undefined}}><label style={{fontSize:11,color:T.mute,display:'block',marginBottom:5}}>{label}</label>{/comments|remarks/i.test(label) ? <textarea rows={3} value={getPath(draft,path)} onChange={e=>setDraft(setPath(draft,path,e.target.value))} style={{width:'100%',boxSizing:'border-box',padding:'9px 10px',borderRadius:8,border:`1px solid ${T.line}`,background:'transparent',color:T.text,fontFamily:'inherit',resize:'vertical'}}/> : <input value={getPath(draft,path)} onChange={e=>setDraft(setPath(draft,path,e.target.value))} style={{width:'100%',boxSizing:'border-box',padding:'9px 10px',borderRadius:8,border:`1px solid ${T.line}`,background:'transparent',color:T.text,outline:'none'}}/>}</div>)}</div></div>)}
        {problem&&<div style={{color:T.accent,fontSize:13,marginBottom:12}}>{problem.message}</div>}
        <div style={{display:'flex',gap:8}}><Btn variant="line" onClick={()=>setEditing(false)}>Cancel</Btn><Btn busy={busy} onClick={save}>{busy?'Saving…':'Save History'}</Btn></div>
      </div>
    </div>}
  </div>;
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
  const set = (patch) => { setF({ ...f, ...patch }); setProblem(null); };

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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 8 }}>
          <div>
            <div className="mono" style={label}>Latitude (optional)</div>
            <input value={f.latitude} onChange={(e) => set({ latitude: e.target.value })}
              placeholder="13.082700" className="mono" style={latOk || f.latitude === '' ? field : bad} />
          </div>
          <div>
            <div className="mono" style={label}>Longitude (optional)</div>
            <input value={f.longitude} onChange={(e) => set({ longitude: e.target.value })}
              placeholder="80.270700" className="mono" style={lngOk || f.longitude === '' ? field : bad} />
          </div>
        </div>
        {/* Coordinates decide whether a real trainer can punch in, so this
            says plainly where they must come from. Nothing is guessed. */}
        <div style={{ fontSize: 12, color: T.mute, lineHeight: 1.6, marginBottom: 24 }}>
          {blank
            ? 'Leave these blank if you do not have them yet. The school will be saved, but nobody can punch in there until a position is confirmed.'
            : 'Stand at the school, long-press your position in Google Maps, and copy the two numbers it shows. Do not estimate: a wrong coordinate means nobody can punch in there.'}
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
