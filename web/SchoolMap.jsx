import React, { useState, useMemo } from 'react';

/**
 * School Map.
 *
 * A locator, not a street map. It plots schools on India's bounding box
 * so an admin can see roughly where they are and how they cluster by zone.
 *
 * Deliberately no tile provider, no API key, no map library and no cost:
 * for ~140 schools the useful questions are "where roughly is this" and
 * "take me there", and the second is answered better by Google Maps than
 * by anything embedded here.
 */

// Mainland India plus a margin, so Chennai does not sit on the edge.
const BOUNDS = { minLat: 6.5, maxLat: 35.8, minLng: 67.5, maxLng: 97.5 };

/** Equirectangular projection. Fine at this scale for a locator. */
function project(lat, lng, w, h) {
  const x = ((lng - BOUNDS.minLng) / (BOUNDS.maxLng - BOUNDS.minLng)) * w;
  const y = (1 - (lat - BOUNDS.minLat) / (BOUNDS.maxLat - BOUNDS.minLat)) * h;
  return { x, y };
}
const inBounds = (lat, lng) =>
  lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng;

/**
 * Google Maps directions link. Opened in a new tab; navigation happens
 * there, not here.
 */
export function directionsUrl(school, from) {
  if (school.latitude === null || school.longitude === null) return null;
  const dest = `${school.latitude},${school.longitude}`;
  const params = new URLSearchParams({ api: '1', destination: dest, travelmode: 'driving' });
  // Directions from where the admin actually is, when they have shared it.
  if (from && Number.isFinite(from.latitude) && Number.isFinite(from.longitude)) {
    params.set('origin', `${from.latitude},${from.longitude}`);
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function SchoolMap({ T, schools, isPhone, onViewDetails, onClose }) {
  const [me, setMe] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState(null);
  const [selected, setSelected] = useState(null);

  const W = 600, H = 620;

  // Only schools with a confirmed position are plotted. Nothing is guessed.
  const plotted = useMemo(
    () => (schools || [])
      .filter((s) => s.latitude !== null && s.longitude !== null)
      .map((s) => ({ ...s, lat: Number(s.latitude), lng: Number(s.longitude) }))
      .filter((s) => inBounds(s.lat, s.lng))
      .map((s) => ({ ...s, ...project(s.lat, s.lng, W, H) })),
    [schools]);

  const missing = (schools || []).filter((s) => s.latitude === null || s.longitude === null);
  const outside = (schools || []).filter((s) =>
    s.latitude !== null && !inBounds(Number(s.latitude), Number(s.longitude)));

  const myPoint = me && inBounds(me.latitude, me.longitude)
    ? project(me.latitude, me.longitude, W, H) : null;

  /** Location is read once, only when the admin asks. Never watched. */
  const locate = () => {
    setLocating(true); setLocError(null);
    if (!navigator.geolocation) {
      setLocError('This device cannot report its location.');
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setMe({ latitude: p.coords.latitude, longitude: p.coords.longitude,
                accuracy: Math.round(p.coords.accuracy) });
        setLocating(false);
      },
      (e) => {
        setLocError(e.code === 1
          ? 'Location permission was declined. Directions will still open without a starting point.'
          : 'Could not read your location.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  };

  const label = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: T.faint };
  const btn = (primary) => ({
    padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
    background: primary ? T.text : 'transparent', color: primary ? T.bg : T.text,
    border: primary ? 'none' : `1px solid ${T.line}`,
  });

  return (
    <div className="fade" style={{
      position: 'fixed', inset: 0, background: T.overlay, zIndex: 70, display: 'flex',
      alignItems: isPhone ? 'flex-end' : 'center', justifyContent: 'center', padding: isPhone ? 0 : 16,
    }}>
      <div className="rise" style={{
        width: '100%', maxWidth: 720, background: T.bg, borderRadius: isPhone ? '16px 16px 0 0' : 16,
        border: `1px solid ${T.line}`, maxHeight: '94vh', overflowY: 'auto', padding: isPhone ? 20 : 28,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <div className="tight" style={{ fontSize: 18, fontWeight: 600 }}>School Map</div>
          <button className="press" onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: T.mute, marginBottom: 16, lineHeight: 1.6 }}>
          {plotted.length} of {(schools || []).length} schools have a confirmed position.
          Tap a marker for details and directions.
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button className="press" onClick={locate} disabled={locating} style={btn(false)}>
            {locating ? 'Locating…' : me ? 'Update my location' : 'Show my location'}
          </button>
          {me && (
            <span className="mono" style={{ ...label, alignSelf: 'center' }}>
              you: {me.latitude.toFixed(4)}, {me.longitude.toFixed(4)} · ±{me.accuracy} m
            </span>
          )}
        </div>
        {locError && (
          <div className="fade" style={{ fontSize: 12, color: T.accent, marginBottom: 14, lineHeight: 1.6 }}>
            {locError}
          </div>
        )}

        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of school locations across India"
          style={{
            width: '100%', height: 'auto', background: T.sub,
            border: `1px solid ${T.line}`, borderRadius: 12, display: 'block',
          }}>
          {/* Degree grid: enough reference to read position, nothing more. */}
          {[10, 15, 20, 25, 30, 35].map((lat) => {
            const { y } = project(lat, BOUNDS.minLng, W, H);
            return (
              <g key={`lat${lat}`}>
                <line x1={0} y1={y} x2={W} y2={y} stroke={T.line} strokeWidth="1" strokeDasharray="3 5" />
                <text x={4} y={y - 4} fontSize="10" fill={T.faint} className="mono">{lat}°N</text>
              </g>
            );
          })}
          {[70, 75, 80, 85, 90, 95].map((lng) => {
            const { x } = project(BOUNDS.minLat, lng, W, H);
            return (
              <g key={`lng${lng}`}>
                <line x1={x} y1={0} x2={x} y2={H} stroke={T.line} strokeWidth="1" strokeDasharray="3 5" />
                <text x={x + 4} y={H - 6} fontSize="10" fill={T.faint} className="mono">{lng}°E</text>
              </g>
            );
          })}

          {myPoint && (
            <g>
              <circle cx={myPoint.x} cy={myPoint.y} r="14" fill={T.accent} opacity="0.15" />
              <circle cx={myPoint.x} cy={myPoint.y} r="5" fill={T.accent} stroke={T.bg} strokeWidth="2" />
              <text x={myPoint.x + 10} y={myPoint.y - 8} fontSize="11" fill={T.accent}>You</text>
            </g>
          )}

          {plotted.map((s) => {
            const on = selected?.location_id === s.location_id;
            return (
              <g key={s.location_id} onClick={() => setSelected(s)} style={{ cursor: 'pointer' }}>
                {/* Generous invisible hit area: fingers are not cursors. */}
                <circle cx={s.x} cy={s.y} r="16" fill="transparent" />
                <circle cx={s.x} cy={s.y} r={on ? 8 : 5}
                  fill={s.is_active ? T.text : T.faint}
                  stroke={T.bg} strokeWidth="2" />
                {on && <circle cx={s.x} cy={s.y} r="14" fill="none" stroke={T.text} strokeWidth="1.5" />}
              </g>
            );
          })}
        </svg>

        {selected && (
          <div className="rise" style={{
            marginTop: 16, padding: 16, borderRadius: 12, border: `1px solid ${T.line}`,
          }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{selected.name}</div>
            <div style={{ fontSize: 12, color: T.mute, marginTop: 4 }}>
              {selected.zone}{selected.is_active ? '' : ' · inactive'}
            </div>
            {selected.address && (
              <div style={{ fontSize: 13, color: T.mute, marginTop: 10, lineHeight: 1.6 }}>{selected.address}</div>
            )}
            {(selected.contact_person || selected.contact_phone) && (
              <div style={{ fontSize: 13, marginTop: 10 }}>
                {selected.contact_person}
                {selected.contact_designation ? ` · ${selected.contact_designation}` : ''}
                {selected.contact_phone && (
                  <a href={`tel:${selected.contact_phone}`} style={{ color: T.text, marginLeft: 8 }}>
                    {selected.contact_phone}
                  </a>
                )}
              </div>
            )}
            <div className="mono" style={{ fontSize: 11, color: T.faint, marginTop: 10 }}>
              {selected.latitude}, {selected.longitude}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button className="press" style={btn(false)}
                onClick={() => { onViewDetails(selected.location_id); onClose(); }}>
                View Details
              </button>
              <a className="press" href={directionsUrl(selected, me)} target="_blank" rel="noopener noreferrer"
                style={{ ...btn(true), textDecoration: 'none', display: 'inline-block' }}>
                Get Directions
              </a>
            </div>
            {!me && (
              <div style={{ fontSize: 11, color: T.faint, marginTop: 10 }}>
                Directions will open without a starting point until you share your location.
              </div>
            )}
          </div>
        )}

        {/* Named plainly, so an admin knows what is missing rather than
            wondering why a school is not on the map. */}
        {missing.length > 0 && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.line}` }}>
            <div className="mono" style={{ ...label, marginBottom: 10 }}>
              Location not set ({missing.length})
            </div>
            <div style={{ fontSize: 12, color: T.mute, marginBottom: 12, lineHeight: 1.6 }}>
              These are not on the map, and nobody can punch in at them yet.
            </div>
            {missing.slice(0, 10).map((s) => (
              <button key={s.location_id} className="press row"
                onClick={() => { onViewDetails(s.location_id); onClose(); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 0',
                  background: 'none', border: 'none', borderBottom: `1px solid ${T.line}`,
                  cursor: 'pointer', color: T.text, fontSize: 13,
                }}>
                {s.name} <span style={{ color: T.faint }}>· {s.zone}</span>
              </button>
            ))}
            {missing.length > 10 && (
              <div style={{ fontSize: 12, color: T.faint, marginTop: 10 }}>
                and {missing.length - 10} more
              </div>
            )}
          </div>
        )}

        {outside.length > 0 && (
          <div style={{ fontSize: 12, color: T.accent, marginTop: 16, lineHeight: 1.6 }}>
            {outside.length} school{outside.length > 1 ? 's have' : ' has'} coordinates outside India.
            Check them: a wrong coordinate means nobody can punch in there.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where an attendance or incident was actually recorded.
 * Read-only review of stored evidence; it never changes anything.
 */
export function EvidenceMap({ T, latitude, longitude, accuracy, label }) {
  const lat = Number(latitude), lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const W = 320, H = 200;
  const p = inBounds(lat, lng) ? project(lat, lng, W, H) : null;

  return (
    <div>
      {p ? (
        <svg viewBox={`0 0 ${W} ${H}`} style={{
          width: '100%', height: 'auto', background: T.sub,
          border: `1px solid ${T.line}`, borderRadius: 10, display: 'block',
        }}>
          <circle cx={p.x} cy={p.y} r="12" fill={T.accent} opacity="0.16" />
          <circle cx={p.x} cy={p.y} r="4" fill={T.accent} stroke={T.bg} strokeWidth="1.5" />
        </svg>
      ) : (
        <div style={{ fontSize: 12, color: T.accent }}>Recorded position is outside India.</div>
      )}
      <div className="mono" style={{ fontSize: 11, color: T.faint, marginTop: 8 }}>
        {label ? `${label} · ` : ''}{lat.toFixed(5)}, {lng.toFixed(5)}{accuracy ? ` · ±${accuracy} m` : ''}
      </div>
      <a className="press" href={`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`}
        target="_blank" rel="noopener noreferrer"
        style={{ fontSize: 12, color: T.text, display: 'inline-block', marginTop: 8 }}>
        Open in Google Maps
      </a>
    </div>
  );
}
