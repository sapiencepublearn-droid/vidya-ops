import React, { useState, useMemo, useRef, useEffect } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * School Map — a real basemap with roads and boundaries.
 *
 * Tiles come from OpenStreetMap: free, no API key, no account, no bill.
 * Nothing about a school is sent to them; a tile request only reveals
 * which square of the world is being viewed.
 *
 * Markers are circles rather than Leaflet's default pin, which loads image
 * assets by URL and breaks under a bundler. Circles need no assets and
 * match the rest of the interface.
 */

const INDIA_CENTRE = [22.0, 79.0];
const ACCENT = '#d9451f';

/** Google Maps directions. Navigation happens there, not here. */
export function directionsUrl(school, from) {
  if (school.latitude === null || school.longitude === null) return null;
  const params = new URLSearchParams({
    api: '1',
    destination: `${school.latitude},${school.longitude}`,
    travelmode: 'driving',
  });
  if (from && Number.isFinite(from.latitude) && Number.isFinite(from.longitude)) {
    params.set('origin', `${from.latitude},${from.longitude}`);
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

const hasCoords = (s) => s.latitude !== null && s.longitude !== null;

export function SchoolMap({ T, schools, isPhone, onViewDetails, onClose }) {
  const [me, setMe] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState(null);
  const [selected, setSelected] = useState(null);

  const holder = useRef(null);
  const map = useRef(null);
  const markerLayer = useRef(null);
  const meLayer = useRef(null);

  // Only schools with a confirmed position are plotted. Never guessed.
  const plotted = useMemo(
    () => (schools || []).filter(hasCoords)
      .map((s) => ({ ...s, lat: Number(s.latitude), lng: Number(s.longitude) }))
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)),
    [schools]);

  const missing = (schools || []).filter((s) => !hasCoords(s));

  useEffect(() => {
    if (!holder.current || map.current) return;
    map.current = L.map(holder.current, { center: INDIA_CENTRE, zoom: 4, minZoom: 3 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map.current);
    markerLayer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  // Redraw whenever the school list changes.
  useEffect(() => {
    if (!map.current || !markerLayer.current) return;
    markerLayer.current.clearLayers();

    for (const s of plotted) {
      // The radius the server actually matches against, drawn to scale, so
      // an admin can see whether it covers the school grounds.
      L.circle([s.lat, s.lng], {
        radius: s.radius_metres || 100,
        color: ACCENT, weight: 1, opacity: 0.5, fillColor: ACCENT, fillOpacity: 0.07,
      }).addTo(markerLayer.current);

      L.circleMarker([s.lat, s.lng], {
        radius: 7, color: '#ffffff', weight: 2,
        fillColor: s.is_active ? '#1a1a1a' : '#9a9a9a', fillOpacity: 1,
      })
        .addTo(markerLayer.current)
        .bindTooltip(s.name, { direction: 'top', offset: [0, -8] })
        .on('click', () => setSelected(s));
    }

    if (plotted.length === 1) map.current.setView([plotted[0].lat, plotted[0].lng], 15);
    else if (plotted.length > 1) {
      map.current.fitBounds(L.latLngBounds(plotted.map((s) => [s.lat, s.lng])).pad(0.25));
    }
  }, [plotted]);

  useEffect(() => {
    if (selected && map.current) map.current.setView([selected.lat, selected.lng], 16);
  }, [selected]);

  /** Read once, only when the admin asks. Never watched. */
  const locate = () => {
    setLocating(true); setLocError(null);
    if (!navigator.geolocation) {
      setLocError('This device cannot report its location.');
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const fix = {
          latitude: p.coords.latitude, longitude: p.coords.longitude,
          accuracy: Math.round(p.coords.accuracy),
        };
        setMe(fix); setLocating(false);
        if (!map.current) return;
        meLayer.current?.remove();
        meLayer.current = L.layerGroup([
          L.circle([fix.latitude, fix.longitude], {
            radius: fix.accuracy, color: ACCENT, weight: 1, opacity: 0.4, fillOpacity: 0.08,
          }),
          L.circleMarker([fix.latitude, fix.longitude], {
            radius: 6, color: '#ffffff', weight: 2, fillColor: ACCENT, fillOpacity: 1,
          }).bindTooltip('You are here', { direction: 'top', offset: [0, -8] }),
        ]).addTo(map.current);
        map.current.setView([fix.latitude, fix.longitude], 13);
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
        width: '100%', maxWidth: 760, background: T.bg, borderRadius: isPhone ? '16px 16px 0 0' : 16,
        border: `1px solid ${T.line}`, maxHeight: '94vh', overflowY: 'auto', padding: isPhone ? 20 : 28,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <div className="tight" style={{ fontSize: 18, fontWeight: 600 }}>School Map</div>
          <button className="press" onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.faint, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: T.mute, marginBottom: 16, lineHeight: 1.6 }}>
          {plotted.length} of {(schools || []).length} schools have a confirmed position.
          The shaded ring is the check-in radius. Tap a marker for details.
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="press" onClick={locate} disabled={locating} style={btn(false)}>
            {locating ? 'Locating…' : me ? 'Update my location' : 'Show my location'}
          </button>
          {plotted.length > 0 && (
            <button className="press" style={btn(false)}
              onClick={() => map.current?.fitBounds(
                L.latLngBounds(plotted.map((s) => [s.lat, s.lng])).pad(0.25))}>
              Fit all schools
            </button>
          )}
          {me && <span className="mono" style={label}>±{me.accuracy} m</span>}
        </div>
        {locError && (
          <div className="fade" style={{ fontSize: 12, color: T.accent, marginBottom: 12, lineHeight: 1.6 }}>
            {locError}
          </div>
        )}

        <div ref={holder} style={{
          width: '100%', height: isPhone ? 340 : 440, borderRadius: 12,
          border: `1px solid ${T.line}`, overflow: 'hidden', background: T.sub, zIndex: 0,
        }} />

        {selected && (
          <div className="rise" style={{ marginTop: 16, padding: 16, borderRadius: 12, border: `1px solid ${T.line}` }}>
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
              {selected.latitude}, {selected.longitude} · {selected.radius_metres} m radius
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
  const holder = useRef(null);
  const map = useRef(null);
  const ok = Number.isFinite(lat) && Number.isFinite(lng);

  useEffect(() => {
    if (!holder.current || map.current || !ok) return;
    map.current = L.map(holder.current, {
      center: [lat, lng], zoom: 16, zoomControl: false, scrollWheelZoom: false,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map.current);
    if (accuracy) {
      L.circle([lat, lng], {
        radius: accuracy, color: ACCENT, weight: 1, opacity: 0.4, fillOpacity: 0.08,
      }).addTo(map.current);
    }
    L.circleMarker([lat, lng], {
      radius: 6, color: '#ffffff', weight: 2, fillColor: ACCENT, fillOpacity: 1,
    }).addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, [lat, lng, accuracy, ok]);

  if (!ok) return null;

  return (
    <div>
      <div ref={holder} style={{
        width: '100%', height: 180, borderRadius: 10,
        border: `1px solid ${T.line}`, overflow: 'hidden', background: T.sub, zIndex: 0,
      }} />
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
