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

      <SchoolHistoryCard T={T} api={api} school={s} editing={historyEditing} setEditing={setHistoryEditing} M={M} Btn={Btn} isPhone={isPhone} onSaved={() => detail.reload()} />

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
  ['Books & Payment', [
    ['booksPayment.lkg','LKG — Initial Count'], ['booksPayment.lkgAdditionalOrders','LKG — Additional Orders'], ['booksPayment.lkgReturns','LKG — Returns'],
    ['booksPayment.ukg','UKG — Initial Count'], ['booksPayment.ukgAdditionalOrders','UKG — Additional Orders'], ['booksPayment.ukgReturns','UKG — Returns'],
    ['booksPayment.lkgHhp','LKG — HHP'], ['booksPayment.lkgHhpAdditionalOrders','LKG — HHP Additional Orders'], ['booksPayment.lkgHhpReturns','LKG — HHP Returns'],
    ['booksPayment.ukgHhp','UKG — HHP'], ['booksPayment.ukgHhpAdditionalOrders','UKG — HHP Additional Orders'], ['booksPayment.ukgHhpReturns','UKG — HHP Returns'],
    ['booksPayment.deliveryDate','Delivery Date'], ['booksPayment.creditNote','P.Y. Credit'], ['booksPayment.discount','Discount'], ['booksPayment.paymentMode','Payment Mode'],
    ['booksPayment.spInvoiceValueMo','SP Invoice Value (MO)'], ['booksPayment.spInvoiceValueAo','SP Invoice Value (AO)'], ['booksPayment.spInvoiceValue2526Total','25-26 Total'],
    ['booksPayment.amountReceived','Amount Received'], ['booksPayment.amountReceivedDate','Amount Received Date'], ['booksPayment.amountPending','Amount Pending'], ['booksPayment.status','Status'], ['booksPayment.remarks','Remarks']
  ]],
  ['Deliverables 1', [['deliverables1.teachersCopy','Teachers Copy — Count'], ['deliverables1.teachersCopyDate','Teachers Copy — Date'], ['deliverables1.teachersManual1','Teachers Manual — Count'], ['deliverables1.teachersManual1Date','Teachers Manual — Date'], ['deliverables1.teachersManual2','Teachers Manual 2 — Count'], ['deliverables1.teachersManual2Date','Teachers Manual 2 — Date'], ['deliverables1.flashCards','Flash Card — Count'], ['deliverables1.flashCardsDate','Flash Card — Date']]],
  ['Deliverables 2', [['deliverables2.whatsapp','WhatsApp — Count'], ['deliverables2.whatsappDate','WhatsApp — Date'], ['deliverables2.windowsApp.appVersion','Windows App — Version'], ['deliverables2.windowsApp.date','Windows App — Date'], ['deliverables2.windowsApp.lkg','Windows App — LKG'], ['deliverables2.windowsApp.ukg','Windows App — UKG'], ['deliverables2.windowsApp.systemTvBoth','Windows App — System / TV / Both'], ['deliverables2.kidsApp.appVersion','Kids App — Version'], ['deliverables2.kidsApp.date','Kids App — Date'], ['deliverables2.kidsApp.count','Kids App — Count'], ['deliverables2.kidsApp.ukg','Kids App — UKG'], ['deliverables2.kidsApp.systemTvBoth','Kids App — System / TV / Both'], ['deliverables2.appComments','App Comments']]],
  ['Deliverables 3', [['deliverables3.questionPaper','Question Paper — Count'], ['deliverables3.questionPaperDate','Question Paper — Date'], ['deliverables3.progressCard','Progress Card — Count'], ['deliverables3.progressCardDate','Progress Card — Date']]],
  ['Services', [['services.t1','T1'], ['services.atu1','ATU 1'], ['services.atu1Comments','ATU 1 Comments'], ['services.sim1','SIM 1'], ['services.sim1Comments','SIM 1 Comments'], ['services.t2','T2'], ['services.generalVisit','General Visit'], ['services.atu2','ATU 2'], ['services.atu2Comments','ATU 2 Comments'], ['services.sim2','SIM 2'], ['services.sim2Comments','SIM 2 Comments'], ['services.t3','T3'], ['services.sim3','SIM 3'], ['services.sim3Comments','SIM 3 Comments']]],
  ['Current status', [['currentStatus','Current Status'], ['comments','Comments']]],
];
function getPath(obj, path) { return path.split('.').reduce((v,k) => v?.[k], obj) ?? ''; }
function setPath(obj, path, value) { const keys=path.split('.'); const out={...obj}; let cur=out; keys.slice(0,-1).forEach(k=>{ cur[k]={...(cur[k]||{})}; cur=cur[k]; }); cur[keys[keys.length-1]]=value; return out; }

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
  const count = readU16(view, eocd + 10), cdOffset = readU32(view, eocd + 16);
  const entries = new Map(); let off = cdOffset;
  const bytes = new Uint8Array(buffer), decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (readU32(view, off) !== 0x02014b50) throw new Error('Invalid Excel archive.');
    const method = readU16(view, off + 10), compressedSize = readU32(view, off + 20), nameLen = readU16(view, off + 28), extraLen = readU16(view, off + 30), commentLen = readU16(view, off + 32), localOffset = readU32(view, off + 42);
    const name = decoder.decode(bytes.slice(off + 46, off + 46 + nameLen));
    entries.set(name, { method, compressedSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const get = async (name) => { const entry=entries.get(name); if(!entry)return null; return new TextDecoder().decode(await unzipEntry(buffer,entry)); };
  const sharedXml = await get('xl/sharedStrings.xml');
  const shared = sharedXml ? Array.from(new DOMParser().parseFromString(sharedXml,'application/xml').querySelectorAll('si')).map(si=>Array.from(si.querySelectorAll('t')).map(t=>t.textContent).join('')) : [];
  const workbookXml = await get('xl/workbook.xml'), relsXml = await get('xl/_rels/workbook.xml.rels');
  const workbookDoc=workbookXml?new DOMParser().parseFromString(workbookXml,'application/xml'):null, relsDoc=relsXml?new DOMParser().parseFromString(relsXml,'application/xml'):null;
  const relMap={}; relsDoc?.querySelectorAll('Relationship').forEach(r=>relMap[r.getAttribute('Id')]=r.getAttribute('Target'));
  const sheets=Array.from(workbookDoc?.querySelectorAll('sheet')||[]);
  const targetFor=(sh)=>{const target=relMap[sh?.getAttribute('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]||relMap[sh?.getAttribute('r:id')]; return target?(target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\//,'')}`):'';};
  let chosen=sheets.map(sh=>({name:normExcel(sh.getAttribute('name')||''),path:targetFor(sh)})).find(x=>/school\s*(name|history)|school\s*history/i.test(x.name)||/school\s*history/i.test(x.path));
  if(!chosen) chosen=sheets.map(sh=>({name:normExcel(sh.getAttribute('name')||''),path:targetFor(sh)}))[0]||{name:'Sheet1',path:'xl/worksheets/sheet1.xml'};
  const sheetXml=await get(chosen.path); if(!sheetXml)throw new Error('The School History worksheet could not be read.');
  const doc=new DOMParser().parseFromString(sheetXml,'application/xml'), cells={};
  doc.querySelectorAll('sheetData > row > c').forEach(c=>{const ref=c.getAttribute('r'),type=c.getAttribute('t'),v=c.querySelector('v'),inline=c.querySelector('is');let value=inline?Array.from(inline.querySelectorAll('t')).map(t=>t.textContent).join(''):(v?.textContent||'');if(type==='s')value=shared[Number(value)]??'';if(type==='b')value=value==='1'?'TRUE':'FALSE';cells[ref]=String(value).trim();});
  return {cells,sheetName:chosen.name};
}

const excelText=(cells,ref)=>String(cells[ref]??'').trim();
const normExcel=(v)=>String(v??'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const excelDateText=(value)=>{const raw=normExcel(value);if(!raw)return '';if(/^\d+(?:\.\d+)?$/.test(raw)){const serial=Number(raw);if(serial>20000&&serial<80000){const d=new Date(Date.UTC(1899,11,30)+serial*86400000);return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;}}const m=raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);if(m)return `${String(Number(m[2])).padStart(2,'0')}/${String(Number(m[1])).padStart(2,'0')}/${m[3]}`;return raw;};
const cleanExcelLabel=(v)=>normExcel(v).replace(/[:：]$/,'').replace(/\s+/g,' ').toLowerCase();
const stripExcelLabel=(v)=>normExcel(v).replace(/^\s*[^:：]+[:：]\s*/,'').trim();
const isBlankExcel=(v)=>{const x=normExcel(v).toLowerCase();return !x||x==='-'||x==='—'||x==='nil';};
// Ignore accidental diagnostic text pasted into Excel comments.
const isImportedDiagnosticText=(v)=>/sandbox does not have usable installed dependencies|won't claim a full production run passed/i.test(normExcel(v));

// IMPORTANT: This importer is deliberately row-semantic for the supplied
// School History workbook. The workbook is a form with special rows such as
// DELIVERY DATE, DISCOUNT, SP INVOICE VALUE (MO), and a second DELIVERABLES 2
// header. Generic "find the next value" logic caused STATUS/PAYMENT MODE/date
// values to shift into the previous field. We now identify each semantic row,
// then read only the columns belonging to that row's header.
function importSchoolHistoryTemplate(cells,current){
  const out=JSON.parse(JSON.stringify(current||{}));
  // Re-import must replace previously imported values. Otherwise a bad import
  // such as "PAYMENT MODE" in Discount — Additional Orders would survive
  // even after the mapping was corrected. Preserve unrelated top-level data,
  // but reset every School History section handled by this importer.
  out.contacts={}; out.booksPayment={}; out.deliverables1={}; out.deliverables2={}; out.deliverables3={}; out.services={}; out.currentStatus=''; out.comments='';
  const entries=Object.entries(cells).map(([ref,value])=>{const m=ref.match(/^([A-Z]+)(\d+)$/);if(!m)return null;let col=0;for(const ch of m[1])col=col*26+ch.charCodeAt(0)-64;return {ref,row:Number(m[2]),col,value:normExcel(value)};}).filter(Boolean);
  const rows=new Map(); for(const e of entries){if(!rows.has(e.row))rows.set(e.row,[]);rows.get(e.row).push(e);} for(const r of rows.values())r.sort((a,b)=>a.col-b.col);
  const rowVals=(r)=>rows.get(r)||[];
  const exact=(v,label)=>cleanExcelLabel(v)===cleanExcelLabel(label);
  const matchesLabel=(v,label)=>{const n=cleanExcelLabel(v),l=cleanExcelLabel(label);return n===l||n.startsWith(l+':')||n.startsWith(l+'：');};
  const labelCell=(r,label)=>rowVals(r).find(x=>matchesLabel(x.value,label))||null;
  const rowWithLabel=(label,start=1,end=9999)=>{for(const [r,vals] of rows){if(r<start||r>end)continue;if(vals.some(x=>matchesLabel(x.value,label)))return r;}return null;};
  const cell=(r,c)=>rowVals(r).find(x=>x.col===c)?.value||'';
  const rightValues=(r,label)=>{const vals=rowVals(r),idx=vals.findIndex(x=>matchesLabel(x.value,label));return idx<0?[]:vals.slice(idx+1).map(x=>x.value).filter(v=>!isBlankExcel(v));};
  const valueRight=(r,label,offset=0)=>rightValues(r,label)[offset]||'';
  const rowLabel=(r)=>rowVals(r)[0]?.value||'';
  const set=(path,value,date=false)=>{let v=normExcel(value);if(isImportedDiagnosticText(v))return;if(date)v=excelDateText(v);if(!isBlankExcel(v))Object.assign(out,setPath(out,path,v));};

  // Basic details
  for(const [label,key] of [['LOCATION','location'],['VINTAGE','vintage'],['BOOKS','books'],['CATEGORY','category']]){const r=rowWithLabel(label,1,8);if(r){const ownCell=labelCell(r,label);const own=ownCell&&!exact(ownCell.value,label)?normExcel(ownCell.value).replace(/^[^:：]+[:：]\s*/,''):'';set(key,own||valueRight(r,label));}}
  const schoolRow=rowWithLabel('SCHOOL NAME',1,4); const schoolName=schoolRow? (normExcel(labelCell(schoolRow,'SCHOOL NAME')?.value||'').replace(/^SCHOOL NAME\s*[:：]\s*/i,'')||valueRight(schoolRow,'SCHOOL NAME')) : normExcel(cell(2,1));

  // Contacts: name is first non-empty cell after the role; phone is the next
  // phone-like cell. "nil" is not a phone and is ignored.
  for(const [label,key,phoneKey] of [['CORRESPONDENT','correspondent','correspondentPhone'],['PRINCIPAL','principal','principalPhone'],['KEY PERSON','keyPerson','keyPersonPhone']]){
    const r=rowWithLabel(label,1,20); if(!r)continue; const vals=rightValues(r,label); const name=vals.find(v=>!/^\+?\d[\d\s().-]{7,}$/.test(v))||''; const phone=vals.find(v=>/^\+?\d[\d\s().-]{7,}$/.test(v))||''; set(`contacts.${key}`,name); set(`contacts.${phoneKey}`,phone);
  }

  // Books & payment header. We read book rows only by their exact row labels;
  // DISCOUNT and all payment rows are handled separately so they can never
  // steal values from the count/additional/returns columns.
  const bpHeader=rowWithLabel('INITIAL COUNT',1,25);
  const bpHeaderVals=bpHeader?rowVals(bpHeader):[];
  const headerCol=(label)=>bpHeaderVals.find(x=>exact(x.value,label))?.col||null;
  const cInitial=headerCol('INITIAL COUNT')||2,cAdditional=headerCol('ADDITIONAL ORDERS')||3,cReturns=headerCol('RETURNS')||4;
  const bookRows=[['LKG','lkg'],['UKG','ukg'],['LKG - HHP','lkgHhp'],['UKG - HHP','ukgHhp']];
  for(const [label,key] of bookRows){const r=rowWithLabel(label,bpHeader?bpHeader+1:1,40);if(!r)continue;set(`booksPayment.${key}`,cell(r,cInitial));set(`booksPayment.${key}AdditionalOrders`,cell(r,cAdditional));set(`booksPayment.${key}Returns`,cell(r,cReturns));}

  const firstValueAfter=(r,label,stopLabels=[])=>{const vals=rowVals(r),lc=labelCell(r,label);if(!lc)return '';const stops=new Set(stopLabels.map(cleanExcelLabel));for(const x of vals.filter(v=>v.col>lc.col).sort((a,b)=>a.col-b.col)){const n=cleanExcelLabel(x.value);if(stops.has(n))break;if(!isBlankExcel(x.value))return x.value;}return '';};
  const delivery=rowWithLabel('DELIVERY DATE',1,40);if(delivery){set('booksPayment.deliveryDate',firstValueAfter(delivery,'DELIVERY DATE'),true);const creditLabel=labelCell(delivery,'P.Y. Credit');if(creditLabel){const creditVal=rowVals(delivery).filter(x=>x.col>creditLabel.col&&!isBlankExcel(x.value))[0]?.value||'';set('booksPayment.creditNote',creditVal);}}
  const discount=rowWithLabel('DISCOUNT',1,40);if(discount){set('booksPayment.discount',firstValueAfter(discount,'DISCOUNT',['PAYMENT MODE']));const pm=labelCell(discount,'PAYMENT MODE');if(pm){const pv=rowVals(discount).filter(x=>x.col>pm.col&&!isBlankExcel(x.value))[0]?.value||'';set('booksPayment.paymentMode',pv);}}

  const inv=rowWithLabel('SP INVOICE VALUE (MO)',1,45)||rowWithLabel('SP INVOICE VALUE (25-26)',1,45);if(inv){const moLabel=labelCell(inv,'SP INVOICE VALUE (MO)')||labelCell(inv,'SP INVOICE VALUE (25-26)');if(moLabel){const moVal=rowVals(inv).filter(x=>x.col>moLabel.col&&!isBlankExcel(x.value))[0]?.value||'';set('booksPayment.spInvoiceValueMo',moVal);set('booksPayment.spInvoiceValue2526',moVal);}const aoLabel=labelCell(inv,'SP INVOICE VALUE (AO)');if(aoLabel){const aoVal=firstValueAfter(inv,'SP INVOICE VALUE (AO)',['25-26 TOTAL']);set('booksPayment.spInvoiceValueAo',aoVal);}const totalLabel=labelCell(inv,'25-26 Total');if(totalLabel){const totalVal=rowVals(inv).filter(x=>x.col>totalLabel.col&&!isBlankExcel(x.value))[0]?.value||'';set('booksPayment.spInvoiceValue2526Total',totalVal);}}
  const received=rowWithLabel('AMOUNT RECEIVED',1,45);if(received){set('booksPayment.amountReceived',valueRight(received,'AMOUNT RECEIVED',0));const vals=rightValues(received,'AMOUNT RECEIVED');const di=vals.findIndex(v=>cleanExcelLabel(v)==='date');if(di>=0&&vals[di+1])set('booksPayment.amountReceivedDate',vals[di+1],true);}
  const pending=rowWithLabel('AMOUNT PENDING',1,45);if(pending){set('booksPayment.amountPending',valueRight(pending,'AMOUNT PENDING',0));const vals=rightValues(pending,'AMOUNT PENDING');const si=vals.findIndex(v=>cleanExcelLabel(v)==='status');if(si>=0&&vals[si+1])set('booksPayment.status',vals[si+1]);}
  const status=rowWithLabel('STATUS',1,45);if(status){const own=stripExcelLabel(rowVals(status).find(x=>exact(x.value,'STATUS'))?.value||'');if(own)set('booksPayment.status',own);else set('booksPayment.status',valueRight(status,'STATUS',0));}
  const bpComments=rowWithLabel('COMMENTS',1,45);if(bpComments && bpComments<=(pending||45))set('booksPayment.remarks',valueRight(bpComments,'COMMENTS',0));

  // Deliverables 1 has COUNT/DATE headers. The singular "Teachers Manual"
  // in the workbook maps to teachersManual1; the old teachersManual2 field is
  // retained for backwards compatibility but is not invented during import.
  const d1=rowWithLabel('DELIVERABLES 1',1,50);const d1HeaderVals=d1?rowVals(d1+1):[];const d1Count=d1HeaderVals.find(x=>exact(x.value,'COUNT'))?.col||2,d1Date=d1HeaderVals.find(x=>exact(x.value,'DATE'))?.col||3;
  for(const [labels,key] of [[['TEACHERS COPY'],'teachersCopy'],[['TEACHERS MANUAL','TEACHERS MANUAL 1'],'teachersManual1'],[['TEACHERS MANUAL 2'],'teachersManual2'],[['FLASH CARD','FLASH CARDS'],'flashCards']]){let r=null;for(const a of labels){r=rowWithLabel(a,(d1||1)+1,50);if(r)break;}if(!r)continue;set(`deliverables1.${key}`,cell(r,d1Count));set(`deliverables1.${key}Date`,cell(r,d1Date),true);}

  // Deliverables 2 has TWO headers. WhatsApp is its own row; the later
  // "NEW APP / DATE" header applies to Windows App and Kids App rows.
  const d2=rowWithLabel('DELIVERABLES 2',1,55);if(d2){const nextHeader=rowWithLabel('DELIVERABLES 2',d2+1,55);const wa=rowWithLabel('WHATSAPP',d2+1,(nextHeader||55)-1);if(wa){set('deliverables2.whatsapp',cell(wa,2));set('deliverables2.whatsappDate',cell(wa,3),true);}
    const appHeader=nextHeader?rowVals(nextHeader):[];const appVersionCol=appHeader.find(x=>exact(x.value,'NEW APP'))?.col||2;const appDateCol=appHeader.find(x=>exact(x.value,'DATE'))?.col||3;
    const win=rowWithLabel('WINDOWS APP',(nextHeader||d2)+1,55);const kids=rowWithLabel('KIDS APP',(nextHeader||d2)+1,55);
    if(win){set('deliverables2.windowsApp.appVersion',cell(win,appVersionCol));set('deliverables2.windowsApp.date',cell(win,appDateCol),true);}
    if(kids){set('deliverables2.kidsApp.count',cell(kids,2));set('deliverables2.kidsApp.lkg',cell(kids,2));set('deliverables2.kidsApp.date',cell(kids,appDateCol),true);set('deliverables2.kidsApp.systemTvBoth',cell(kids,4));}
    const appComments=rowWithLabel('WINDOWS APP COMMENTS',(kids||win||d2)+1,55);if(appComments)set('deliverables2.appComments',valueRight(appComments,'WINDOWS APP COMMENTS',0));
  }

  // Deliverables 3
  const d3=rowWithLabel('DELIVERABLES 3',1,60);const d3HeaderVals=d3?rowVals(d3+1):[];const d3Count=d3HeaderVals.find(x=>exact(x.value,'COUNT'))?.col||2,d3Date=d3HeaderVals.find(x=>exact(x.value,'DATE'))?.col||3;
  for(const [label,key] of [['QUESTION PAPER','questionPaper'],['PROGRESS CARD','progressCard']]){const r=rowWithLabel(label,(d3||1)+1,60);if(r){set(`deliverables3.${key}`,cell(r,d3Count));set(`deliverables3.${key}Date`,cell(r,d3Date),true);}}

  // Services: each service has its own row. No global DATE lookup and no
  // fallback to another service's value.
  const svcStart=rowWithLabel('SERVICES',1,70)||34;
  for(const [label,key] of [['T1','t1'],['ATU 1','atu1'],['ATU 1 COMMENTS','atu1Comments'],['SIM 1','sim1'],['SIM 1 COMMENTS','sim1Comments'],['T2','t2'],['GENERAL VISIT','generalVisit'],['ATU 2','atu2'],['ATU 2 COMMENTS','atu2Comments'],['SIM 2','sim2'],['SIM 2 COMMENTS','sim2Comments'],['T3','t3'],['SIM 3','sim3'],['SIM 3 COMMENTS','sim3Comments']]){const r=rowWithLabel(label,svcStart+1,90);if(r)set(`services.${key}`,valueRight(r,label,0));}
  const currentStatusRow=rowWithLabel('CURRENT STATUS',svcStart+1,100);if(currentStatusRow){const lc=labelCell(currentStatusRow,'CURRENT STATUS');const own=lc&&!exact(lc.value,'CURRENT STATUS')?normExcel(lc.value).replace(/^CURRENT STATUS\s*[:：]\s*/i,''):'';set('currentStatus',own||valueRight(currentStatusRow,'CURRENT STATUS',0));}
  const commentRows=[];for(const [r,vals] of rows){if(r>svcStart&&vals.some(x=>exact(x.value,'COMMENTS')))commentRows.push(r);}const lastComment=commentRows.at(-1);if(lastComment)set('comments',valueRight(lastComment,'COMMENTS',0));
  return {out,schoolName};
}
function SchoolHistoryCard({ T, api, school, editing, setEditing, M, Btn, onSaved, isPhone }) {
  const [busy,setBusy]=useState(false); const [problem,setProblem]=useState(null); const [importing,setImporting]=useState(false);
  const initial=school.school_history || {};
  const [draft,setDraft]=useState(initial);
  useEffect(()=>{ if(!editing) setDraft(school.school_history || {}); },[school.school_history,editing]);
  const save=async()=>{setBusy(true);setProblem(null);try{const out=await api.admin.updateSchoolHistory(school.location_id,draft,newActionKey());setEditing(false);onSaved?.(out?.school_history || draft);}catch(e){setProblem(e);}finally{setBusy(false);}};
  const importExcel=async(e)=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;setImporting(true);setProblem(null);try{const {cells}=await readXlsxFiles(file);const imported=importSchoolHistoryTemplate(cells,draft);const excelSchool=imported.schoolName;if(excelSchool && excelSchool.toLowerCase().replace(/\s+/g,' ')!==school.name.toLowerCase().replace(/\s+/g,' ')){throw new Error(`This Excel file is for “${excelSchool}”, but you are editing “${school.name}”.`);}setDraft(imported.out);}catch(err){setProblem({message:err.message || 'Could not import that Excel file.'});}finally{setImporting(false);}};
  const filled=historySections.flatMap(([,fields])=>fields).filter(([path])=>String(getPath(initial,path)).trim()).length;
  return <div style={{position:'relative',marginBottom:40,padding:18,border:`1px solid ${T.line}`,borderRadius:12,background:T.sub}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}><div><div className="mono" style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.12em',color:T.faint}}>School History</div><M style={{fontSize:12,color:T.mute,display:'block',marginTop:5}}>2025–2026 · {filled} details recorded</M></div><button className="press" title="Edit school history" aria-label="Edit school history" onClick={()=>{setDraft(initial);setProblem(null);setEditing(true)}} style={{width:36,height:36,borderRadius:9,border:`1px solid ${T.line}`,background:T.bg,color:T.text,cursor:'pointer',fontSize:17}}>✎</button></div>
    {!filled ? <M style={{fontSize:13,color:T.mute}}>No history details entered yet. Use the corner edit button to add the school record.</M> : historySections.map(([title,fields])=>{
      if(title==='Contacts'){
        const contacts=[['Correspondent','contacts.correspondent','contacts.correspondentPhone'],['Principal','contacts.principal','contacts.principalPhone'],['Key Person','contacts.keyPerson','contacts.keyPersonPhone']]
          .map(([role,namePath,phonePath])=>({role,name:String(getPath(initial,namePath)).trim(),phone:String(getPath(initial,phonePath)).trim()}))
          .filter(x=>x.name||x.phone);
        if(!contacts.length)return null;
        return <div key={title} style={{borderTop:`1px solid ${T.line}`,paddingTop:12,marginTop:12}}>
          <div style={{fontSize:12,fontWeight:600,marginBottom:8}}>{title}</div>
          {contacts.map((x,i)=>{const tel=x.phone.replace(/[^+\d]/g,'');return <div key={i} style={{display:'grid',gridTemplateColumns:isPhone?'92px minmax(0,1fr)':'140px minmax(0,1fr)',gap:isPhone?8:12,alignItems:'start',padding:'6px 0',fontSize:12}}>
            <span style={{color:T.faint}}>{x.role}</span>
            <div style={{minWidth:0}}>
              {x.name&&<div style={{color:T.text,overflowWrap:'anywhere'}}>{x.name}</div>}
              {x.phone&&<a className="press" href={`tel:${tel}`} aria-label={`Call ${x.role} ${x.phone}`} style={{display:'inline-flex',alignItems:'center',gap:6,marginTop:x.name?3:0,color:T.text,textDecoration:'none',fontWeight:600,whiteSpace:'nowrap',touchAction:'manipulation'}}><span aria-hidden="true">☎</span><span>{x.phone}</span></a>}
            </div>
          </div>})}
        </div>;
      }
      const vals=fields.map(([path,label])=>[label,String(getPath(initial,path)).trim()]).filter(([,v])=>v);if(!vals.length)return null;
      return <div key={title} style={{borderTop:`1px solid ${T.line}`,paddingTop:12,marginTop:12}}><div style={{fontSize:12,fontWeight:600,marginBottom:8}}>{title}</div>{vals.map(([label,value])=><div key={label} style={{display:'grid',gridTemplateColumns:isPhone?'minmax(0,42%) minmax(0,1fr)':'190px minmax(0,1fr)',gap:10,padding:'5px 0',fontSize:12}}><span style={{color:T.faint,minWidth:0}}>{label}</span><span style={{color:T.text,whiteSpace:'pre-wrap',minWidth:0,overflowWrap:'anywhere'}}>{value}</span></div>)}</div>
    })}
    {editing && <div className="fade" style={{position:'fixed',inset:0,zIndex:80,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}><div className="rise" style={{width:'100%',maxWidth:720,maxHeight:'92vh',overflowY:'auto',background:T.bg,border:`1px solid ${T.line}`,borderRadius:14,padding:22}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><div><div className="tight" style={{fontSize:20,fontWeight:600}}>Edit School History</div><M style={{fontSize:12,color:T.mute}}>{school.name} · 2025–2026</M></div><button onClick={()=>setEditing(false)} style={{background:'none',border:'none',color:T.faint,fontSize:20,cursor:'pointer'}}>×</button></div>
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:18,flexWrap:'wrap'}}><label className="press" style={{display:'inline-flex',alignItems:'center',gap:7,padding:'8px 12px',borderRadius:8,border:`1px solid ${T.line}`,cursor:importing?'wait':'pointer',fontSize:12,color:T.text}}><span>Import Excel</span><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importExcel} disabled={importing} style={{display:'none'}}/></label><span style={{fontSize:12,color:T.faint}}>Imports the supplied 2025–2026 School History format and fills the form. You can edit anything before saving.</span></div>
      {historySections.map(([title,fields])=><div key={title} style={{marginBottom:22}}><div className="mono" style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.12em',color:T.faint,marginBottom:10}}>{title}</div><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}}>{fields.map(([path,label])=><div key={path} style={{gridColumn:/comments|remarks|appComments/i.test(label)?'1 / -1':undefined}}><label style={{fontSize:11,color:T.mute,display:'block',marginBottom:5}}>{label}</label>{/comments|remarks/i.test(label)?<textarea rows={3} value={getPath(draft,path)} onChange={e=>setDraft(setPath(draft,path,e.target.value))} style={{width:'100%',boxSizing:'border-box',padding:'9px 10px',borderRadius:8,border:`1px solid ${T.line}`,background:'transparent',color:T.text,fontFamily:'inherit',resize:'vertical'}}/>:<input value={getPath(draft,path)} onChange={e=>setDraft(setPath(draft,path,e.target.value))} style={{width:'100%',boxSizing:'border-box',padding:'9px 10px',borderRadius:8,border:`1px solid ${T.line}`,background:'transparent',color:T.text,outline:'none'}}/>}</div>)}</div></div>)}
      {problem&&<div style={{color:T.accent,fontSize:13,marginBottom:12}}>{problem.message}</div>}<div style={{display:'flex',gap:8}}><Btn variant="line" onClick={()=>setEditing(false)}>Cancel</Btn><Btn busy={busy} onClick={save}>{busy?'Saving…':'Save History'}</Btn></div>
    </div></div>}
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
