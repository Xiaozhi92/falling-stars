import { useEffect, useMemo, useRef, useState } from 'react'
import Globe from 'react-globe.gl'
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import {
  parseCsv,
  classifyMeteorite,
  CLASS_COLORS,
  CLASS_LABELS,
  CLASS_LABELS_SHORT,
  CLASS_ORDER,
} from './data.js'
import './App.css'

/* ---------------------------------------------------------------
 * Phase 2.5 architecture: defer to three-globe's built-in layers.
 *
 * Why we deleted ~150 lines of custom InstancedMesh code:
 *   `react-globe.gl` already wraps `three-globe` which has a built-in
 *   Points layer (single merged draw call, mass-altitude scaling,
 *   per-point click/hover) and Rings layer (impact ripples).
 *   We were rebuilding both from scratch with custom shaders.
 *
 * Visual constraints (manager A. 克制中间路):
 *   - Vertical column max altitude: 0.04 × R (NOT 0.075R "Hoba laser")
 *   - Reads as "specimen pin in archive drawer", not "TRON laser"
 *   - Class-tinted toward amber so all rays sit in one hue family
 */

// Map mass (grams) to a normalized altitude in [0, 1] via log scale.
// 1g  → 0.05    (tiny pebble — barely visible)
// 1kg → 0.18
// 1t  → 0.45
// 60t → 1.0    (Hoba — tallest pin in the archive)
function massToAltitude(mass) {
  if (!mass || mass <= 0) return 0.05
  // log10(60_000_000g) = 7.78 → use 7.8 as max anchor
  const t = Math.min(1, Math.max(0, Math.log10(mass) / 7.8))
  return 0.05 + t * 0.95
}

const MAX_ALT_R = 0.05 // 5% of globe radius — manager A. middle path, slight bump for visibility

// Tint each class color toward amber so the three classes sit in one hue family.
const TINTED_AMBER = '#d4a85f'
function tintTowardAmber(hex, amount = 0.55) {
  // simple lerp in sRGB — close enough for our muted palette
  const a = parseInt(hex.slice(1), 16)
  const b = parseInt(TINTED_AMBER.slice(1), 16)
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff
  const r = Math.round(ar + (br - ar) * amount)
  const g = Math.round(ag + (bg - ag) * amount)
  const bch = Math.round(ab + (bb - ab) * amount)
  return `rgb(${r}, ${g}, ${bch})`
}

// Per-class point color (used by legend swatches and pre-fall-encoding fallback).
// Phase 2.5+6.4 will switch hero pillars to fall-based color encoding; class
// color survives in the legend swatches and dossier badge.
const POINT_COLORS = Object.fromEntries(
  CLASS_ORDER.map((k) => [k, CLASS_COLORS[k]])
)

const HERO_COUNT = 50 // top mass meteorites get plinth pillar + bloom
const HERO_COLOR = '#F4ECD8'
const PARTICLE_AMBER = '#d4a85f'

/* ----- 4-dim encoding constants (Designer spec) -----
 * radius by class — 6 discrete tiers. Rare classes get more visual presence
 * to compensate for their statistical sparseness.
 */
const CLASS_RADIUS = {
  'planetary': 0.42,        // rarest, privileged
  'stony-iron': 0.36,       // pallasites: rare and beautiful
  'iron': 0.32,             // dense material → thicker
  'carbonaceous': 0.27,
  'achondrite': 0.24,
  'ordinary-chondrite': 0.20, // most common → thinnest
}

const MAX_PILLAR_HEIGHT = 8.0 // in three-globe units (R=100), so 8% radius

// Mass → height with shaped log curve (steeper toward Hoba/Cape York)
function massToPillarHeight(mass) {
  if (!mass || mass <= 0) return MAX_PILLAR_HEIGHT * 0.18 // floor
  const t = Math.pow(Math.min(1, Math.log10(mass + 1) / 8), 1.35)
  return MAX_PILLAR_HEIGHT * (0.18 + 0.82 * t)
}

// Derive a dimmer "Found" variant from the hero color
function deriveFoundColor(hex) {
  const c = new THREE.Color(hex)
  c.lerp(new THREE.Color('#5d5747'), 0.55) // toward paper-faint
  return c
}

const GLOBE_R = 100 // three-globe default

function polar2cart(lat, lng, alt = 0) {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((90 - lng) * Math.PI) / 180
  const r = GLOBE_R * (1 + alt)
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  )
}

/* Build the 50-hero plinth cone field as one InstancedMesh.
 * Truncated cone: radiusBottom=1.0, radiusTop=0.45, height=1, capped.
 * Per-instance scale encodes height (mass) and radius (class).
 * Per-instance color encodes fall (Fell=hero, Found=derived dim).
 *
 * `newIds` (optional): Set of meteorite IDs that just entered the visible
 * window (e.g. via year scrub forward). Their scale.y starts at 0 so the
 * raf loop in App can animate them rising from the surface (fall-in).
 */
function buildHeroCones(heroes, palette, newIds = null) {
  // truncated cone primitive — wide base, narrow top
  const geom = new THREE.CylinderGeometry(
    0.45,  /* radiusTop */
    1.00,  /* radiusBottom */
    1.0,   /* height — will be scaled per instance */
    14,    /* radial segments — smooth-enough silhouette */
    1,     /* height segments */
    false  /* open-ended? false = capped */
  )
  // Shift so the base sits at local y=0 (top at y=1).
  geom.translate(0, 0.5, 0)

  // MeshStandardMaterial respects per-instance .color via instanceColor attribute,
  // and bright fragments will trigger UnrealBloomPass when bloom is on.
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.10,
    emissive: 0x0,
  })

  const mesh = new THREE.InstancedMesh(geom, mat, heroes.length)
  mesh.frustumCulled = false
  mesh.userData.heroes = heroes // for lookup if needed

  const Y_AXIS = new THREE.Vector3(0, 1, 0)
  const tmpQuat = new THREE.Quaternion()
  const tmpMat = new THREE.Matrix4()
  const tmpScale = new THREE.Vector3()
  const tmpColor = new THREE.Color()

  const fellHex = palette.heroColor || '#F4ECD8'
  const foundColor = deriveFoundColor(fellHex)

  for (let i = 0; i < heroes.length; i++) {
    const d = heroes[i]
    const isNew = newIds && newIds.has(d.id)
    // New arrivals start in the sky (alt=1.5, full scale); raf animates inward.
    // Stable heroes anchor just above the surface.
    const startAlt = isNew ? 1.5 : 0.005
    const pos = polar2cart(d.lat, d.lng, startAlt)
    const dir = pos.clone().normalize()
    tmpQuat.setFromUnitVectors(Y_AXIS, dir)

    const height = massToPillarHeight(d.mass)
    const radius = CLASS_RADIUS[d.klass] ?? 0.24

    // Full scale always — falling visual comes from altitude, not size
    tmpScale.set(radius, height, radius)
    tmpMat.compose(pos, tmpQuat, tmpScale)
    mesh.setMatrixAt(i, tmpMat)

    // 4-dim encoding: COLOR by fall — witnessed glows, found is dim
    if (d.fall === 'Fell') {
      tmpColor.set(fellHex)
    } else {
      tmpColor.copy(foundColor)
    }
    mesh.setColorAt(i, tmpColor)
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

// Build a soft radial-gradient sprite texture used for the mid-tier glow points.
// Center cream, fading through amber to transparent. Additive-blended.
function makeGlowTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0.0, 'rgba(248, 234, 200, 1.0)')
  grad.addColorStop(0.18, 'rgba(232, 180, 105, 0.85)')
  grad.addColorStop(0.45, 'rgba(212, 168, 95, 0.30)')
  grad.addColorStop(1.0, 'rgba(212, 168, 95, 0.0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// Producer's "Witness Halos" reframed after vote:
//   - 3D in-globe labels REMOVED (4-agent vote was unanimous against)
//   - C: corner annotation chip (clickable fly-to) — wayfinding
//   - E: dossier "Provenance" line when a clicked specimen is in a region
//   - B: zoom-triggered transient banner when camera flies into a region
const REGIONS = [
  {
    id: 'ansmet',
    short: 'ANSMET',
    full: 'Antarctic Search Program · 1976–present',
    note: '~28,000 specimens recovered from East Antarctic ice',
    center: { lat: -82, lng: 60 },
    contains: (m) => m.lat <= -76,
  },
  {
    id: 'sahara',
    short: 'Saharan Belt',
    full: 'Saharan Find Belt · 1990s–present',
    note: '~4,200 specimens — nomadic + commercial recoveries',
    center: { lat: 25, lng: 0 },
    contains: (m) =>
      m.lat >= 18 && m.lat <= 32 && m.lng >= -15 && m.lng <= 35,
  },
  {
    id: 'pampa',
    short: 'Pampa',
    full: 'Pampa de Argentina',
    note: 'Colonial + indigenous reports',
    center: { lat: -27, lng: -65 },
    contains: (m) =>
      m.lat >= -38 && m.lat <= -22 && m.lng >= -75 && m.lng <= -55,
  },
]

function regionFor(m) {
  return REGIONS.find((r) => r.contains(m)) || null
}

/* ------------------------------------------------------------------
 * First Witness Mode — Producer's cold-open
 * Curated by research agent against NASA Meteoritical Bulletin + sourced quotes.
 * Arc: 861 CE (a child in Kyushu) → 2013 (a million dashcams).
 */
const FIRST_WITNESSES = [
  {
    id: 'nogata',
    name: 'Nōgata',
    year: '861 CE',
    place: 'Fukuoka, Japan',
    lat: 33.73, lng: 130.75,
    framing: 'A boy in a Kyushu rice field watches a stone fall from heaven. The priests believe him. They will keep the stone for 1,165 years.',
    quote: 'A stone fell from heaven, witnessed by a young boy, who led the villagers to the hole the next morning. The priests never doubted it had fallen from the sky.',
  },
  {
    id: 'ensisheim',
    name: 'Ensisheim',
    year: '1492',
    place: 'Alsace',
    lat: 47.87, lng: 7.35,
    framing: 'A boy in a wheat field outside Ensisheim. A thunderclap from a clear sky. The 127 kg stone is chained to the wall of the parish church so it cannot fly away.',
    quote: 'Between the eleventh and the twelfth hour of noon, came a great thunderclap, then a long noise heard far around, then a stone fell from the air.',
  },
  {
    id: 'laigle',
    name: "L'Aigle",
    year: '1803',
    place: 'Normandy, France',
    lat: 48.77, lng: 0.13,
    framing: 'The French Academy sends Jean-Baptiste Biot, age 29, to interview every villager who saw the sky rain stones. His report ends a millennium of scientific denial.',
    quote: 'A rain of stones thrown by the meteor… The foundries, the factories, the mines of the surroundings have nothing in their products that bears any relation to these substances.',
  },
  {
    id: 'pultusk',
    name: 'Pułtusk',
    year: '1868',
    place: 'Poland',
    lat: 52.71, lng: 21.08,
    framing: 'A 7 p.m. fireball drops an estimated 70,000 stones across 127 km² — the densest meteorite shower ever counted.',
    quote: 'It grew very dark for about ten seconds, then a dazzling light like a Bengal fire. The inhabitants ran from their houses, each believing his own house was on fire.',
  },
  {
    id: 'tunguska',
    name: 'Tunguska',
    year: '1908',
    place: 'Siberia',
    lat: 60.89, lng: 101.90,
    framing: 'Vanavara trading post, 65 km from ground zero. A farmer named Semyon Semyonov is thrown from his porch by a sky that splits in two.',
    quote: 'The sky split in two, and high above the forest the whole northern part of the sky appeared covered with fire… my shirt was almost burning on my body.',
  },
  {
    id: 'sikhote',
    name: 'Sikhote-Alin',
    year: '1947',
    place: 'USSR',
    lat: 46.16, lng: 134.65,
    framing: 'An artist named P. I. Medvedev sits down to paint a Russian winter. He paints the wrong sky.',
    quote: 'Brighter than the sun, sweeping across the sky from the north.',
  },
  {
    id: 'chelyabinsk',
    name: 'Chelyabinsk',
    year: '2013',
    place: 'Russia',
    lat: 54.83, lng: 61.12,
    framing: 'A million dashcams. The first meteorite fall in human history watched by more eyes than any single event before it.',
    quote: 'It was brighter than the sun. We thought a war had started.',
  },
]

const FWM_CLOSING = 'It was the 45,716th time we wrote one down. This is the other 45,715.'

/* ---------------- PALETTE DEMO ----------------
 * Five candidate palettes for the boss to flip through and compare live.
 * Each defines the full color stack — CSS tokens (applied to :root) plus
 * react-globe.gl props (applied via Globe component props).
 */
const GLOBE_TEX = {
  blackMarble: '//unpkg.com/three-globe/example/img/earth-dark.jpg',
  blueMarble: '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
  day: '//unpkg.com/three-globe/example/img/earth-day.jpg',
  night: '//unpkg.com/three-globe/example/img/earth-night.jpg',
  bumpmap: '//unpkg.com/three-globe/example/img/earth-topology.png',
}

/* ---------------- USER-MODE PALETTES ----------------
 * Three modes — each serves a different intent the user brings to the archive.
 * Selection persists in localStorage, defaults to Browse on first visit.
 */
const PALETTES = {
  browse: {
    name: 'Atlas',
    sub: 'View the world · natural Earth',
    globeImageUrl: GLOBE_TEX.day,
    bumpImageUrl: GLOBE_TEX.bumpmap,
    globeTint: '#FFFFFF',
    bloomEnabled: false,
    css: {
      '--ink': '#1A1410',
      '--ink-soft': '#3D3833',
      '--paper': '#1A1410',
      '--paper-dim': '#5C5547',
      '--paper-faint': '#8A7D6E',
      '--amber': '#9C2B1F',
      '--amber-soft': '#5C1610',
      '--rule': '#C9BFA9',
      '--cool-accent': '#3D5C7A',
      '--rust-accent': '#9C2B1F',
      '--bg-near': '#F2EDE3',
      '--bg-far': '#DCE3E5',
    },
    atmosphereColor: '#a8b8c4',
    coastlineCap: 'rgba(0,0,0,0)',
    coastlineSide: 'rgba(0,0,0,0)',
    coastlineStroke: 'rgba(0,0,0,0)',
    heroColor: '#1A1410',
    particleColor: '#3D3833',
    ringColor: 'rgba(156, 43, 31, ALPHA)',
  },

  locate: {
    name: 'Sextant',
    sub: 'High contrast · find a specimen',
    globeImageUrl: GLOBE_TEX.blackMarble,
    bumpImageUrl: GLOBE_TEX.bumpmap,
    globeTint: '#5FA8B8',
    bloomEnabled: true,
    css: {
      '--ink': '#050812',
      '--ink-soft': '#0C1226',
      '--paper': '#DCE4F2',
      '--paper-dim': '#8A95AB',
      '--paper-faint': '#4D556A',
      '--amber': '#C24A2C',
      '--amber-soft': '#7A2F1C',
      '--rule': '#1E2840',
      '--cool-accent': '#5FA8B8',
      '--rust-accent': '#C24A2C',
      '--bg-near': '#0C1226',
      '--bg-far': '#050812',
    },
    atmosphereColor: '#5FA8B8',
    coastlineCap: 'rgba(95, 168, 184, 0.04)',
    coastlineSide: 'rgba(95, 168, 184, 0.10)',
    coastlineStroke: 'rgba(95, 168, 184, 0.40)',
    heroColor: '#DCE4F2',
    particleColor: '#C24A2C',
    ringColor: 'rgba(95, 168, 184, ALPHA)',
  },

  archive: {
    name: 'Folio',
    sub: 'Sepia · long-form reading',
    globeImageUrl: GLOBE_TEX.blackMarble,
    bumpImageUrl: GLOBE_TEX.bumpmap,
    globeTint: '#A87440',
    bloomEnabled: true,
    css: {
      '--ink': '#0E0C08',
      '--ink-soft': '#15120B',
      '--paper': '#EDE3CC',
      '--paper-dim': '#B0A382',
      '--paper-faint': '#5F5638',
      '--amber': '#A87440',
      '--amber-soft': '#5C3F23',
      '--rule': '#2B2618',
      '--cool-accent': '#3D547F',
      '--rust-accent': '#8B3A1F',
      '--bg-near': '#15120B',
      '--bg-far': '#080604',
    },
    atmosphereColor: '#A87440',
    coastlineCap: 'rgba(168, 116, 64, 0.06)',
    coastlineSide: 'rgba(168, 116, 64, 0.12)',
    coastlineStroke: 'rgba(168, 116, 64, 0.50)',
    heroColor: '#EDE3CC',
    particleColor: '#A87440',
    ringColor: 'rgba(61, 84, 127, ALPHA)',
  },
}


const FWM_TIMING = {
  metaMs: 1000,      // typewriter for "Year · Place · Name"
  pauseMs: 200,      // pause between meta done and framing start
  framingMs: 1500,   // typewriter for narrative framing
  framingPauseMs: 300, // pause between framing done and quote start
  quoteMs: 3500,     // typewriter for quote
  betweenMs: 1000,   // pause after quote done before next witness
  closingMs: 5500,   // closing line typing
  fadeMs: 2000,      // final fade to globe
}
// Per-witness total wall time
const FWM_PER_WITNESS_MS =
  FWM_TIMING.metaMs +
  FWM_TIMING.pauseMs +
  FWM_TIMING.framingMs +
  FWM_TIMING.framingPauseMs +
  FWM_TIMING.quoteMs +
  FWM_TIMING.betweenMs

export default function App() {
  const globeRef = useRef(null)

  const [meteorites, setMeteorites] = useState(null)
  const [countries, setCountries] = useState(null)
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [yearRange, setYearRange] = useState([1700, 2013])
  const [year, setYear] = useState(2013)
  const [activeClasses, setActiveClasses] = useState(() =>
    Object.fromEntries(CLASS_ORDER.map((k) => [k, true]))
  )
  const [hover, setHover] = useState(null)
  const [selected, setSelected] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [paletteName, setPaletteName] = useState(() => {
    try {
      const saved = localStorage.getItem('palette')
      // migrate legacy demo palette names → user modes
      const migrate = {
        current: 'browse', daylight: 'browse',
        observatory: 'locate', cyanotype: 'locate',
        aprime: 'archive', pureSepia: 'archive', drawer: 'archive',
      }
      if (saved && PALETTES[saved]) return saved
      if (saved && migrate[saved]) return migrate[saved]
      return 'browse'
    } catch { return 'browse' }
  })
  const palette = PALETTES[paletteName] || PALETTES.browse

  // Apply CSS tokens to :root whenever palette changes
  useEffect(() => {
    const root = document.documentElement
    for (const [k, v] of Object.entries(palette.css)) {
      root.style.setProperty(k, v)
    }
    try { localStorage.setItem('palette', paletteName) } catch {}
  }, [paletteName, palette])
  // First Witness Mode: 'check' (initial), 'active', 'closing', 'done'
  const [fwm, setFwm] = useState('check')
  const [fwmIdx, setFwmIdx] = useState(0) // 0..6 = current witness, 7 = closing

  // resize — also force-rerun once after mount (iframe initial size may be stale)
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    // initial double-tap: layout may settle right after first paint
    const t1 = setTimeout(onResize, 100)
    const t2 = setTimeout(onResize, 600)
    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(t1); clearTimeout(t2)
    }
  }, [])

  // Whenever size changes, also poke the underlying three-globe renderer to
  // re-run setSize. This is belt-and-braces — react-globe.gl SHOULD do this
  // via its width/height props but in iframe contexts it sometimes lags.
  useEffect(() => {
    if (!globeRef.current) return
    const renderer = globeRef.current.renderer?.()
    const camera = globeRef.current.camera?.()
    if (renderer && size.w && size.h) {
      renderer.setSize(size.w, size.h, false)
      if (camera && camera.isPerspectiveCamera) {
        camera.aspect = size.w / size.h
        camera.updateProjectionMatrix()
      }
    }
  }, [size, meteorites])

  // First Witness Mode — check localStorage on mount
  useEffect(() => {
    try {
      const seen = localStorage.getItem('fwm-seen')
      // Also skip FWM if there's a deep-link (?m=...), since user is jumping
      // straight to a specimen.
      const hasDeepLink = !!new URL(window.location).searchParams.get('m')
      setFwm(seen || hasDeepLink ? 'done' : 'active')
    } catch {
      setFwm('done')
    }
  }, [])

  // FWM auto-advance — fixed timer per witness; matches sequential typewriter cadence.
  useEffect(() => {
    if (fwm !== 'active') return
    if (fwmIdx >= FIRST_WITNESSES.length) {
      setFwm('closing')
      return
    }
    const t = setTimeout(() => setFwmIdx((i) => i + 1), FWM_PER_WITNESS_MS)
    return () => clearTimeout(t)
  }, [fwm, fwmIdx])

  useEffect(() => {
    if (fwm !== 'closing') return
    const t = setTimeout(() => {
      try { localStorage.setItem('fwm-seen', '1') } catch {}
      setFwm('done')
    }, FWM_TIMING.closingMs + FWM_TIMING.fadeMs)
    return () => clearTimeout(t)
  }, [fwm])

  const skipFwm = () => {
    try { localStorage.setItem('fwm-seen', '1') } catch {}
    setFwm('done')
    setFwmIdx(0)
  }

  // Esc skips during FWM
  useEffect(() => {
    if (fwm !== 'active' && fwm !== 'closing') return
    const onKey = (e) => { if (e.key === 'Escape') skipFwm() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fwm])

  const replayFwm = () => {
    try { localStorage.removeItem('fwm-seen') } catch {}
    setFwmIdx(0)
    setFwm('active')
  }

  // load coastlines
  useEffect(() => {
    fetch('/countries.geojson')
      .then((r) => r.json())
      .then((g) => setCountries(g.features))
      .catch(() => setCountries([]))
  }, [])

  // load + parse meteorites
  useEffect(() => {
    fetch('/meteorites.csv')
      .then((r) => r.text())
      .then((text) => {
        const rows = parseCsv(text)
        const cleaned = []
        let minYear = 9999, maxYear = 0
        for (const r of rows) {
          const lat = parseFloat(r.reclat)
          const lng = parseFloat(r.reclong)
          // Date column is misnamed "year" — it's MM/DD/YYYY [HH:MM:SS AM/PM]
          // Most records are 1/1/YYYY placeholder; ~6,500 have real precision.
          const dateStr = r.year || ''
          const datePart = dateStr.split(' ')[0]
          const dParts = datePart.split('/')
          const dM = parseInt(dParts[0], 10)
          const dD = parseInt(dParts[1], 10)
          const dY = parseInt(dParts[2], 10)
          const yr = isFinite(dY) ? dY : NaN
          // Mass column is now "mass (g)" — header has a space
          const mass = parseFloat(r['mass (g)'] || r.mass)
          if (!isFinite(lat) || !isFinite(lng)) continue
          if (lat === 0 && lng === 0) continue
          if (!isFinite(yr) || yr < 1700 || yr > 2025) continue
          const klass = classifyMeteorite(r.recclass)
          if (!klass) continue
          // Did the date have real precision? (NASA defaults non-precise to Jan 1)
          const hasRealDate = isFinite(dM) && isFinite(dD) && !(dM === 1 && dD === 1)
          cleaned.push({
            name: r.name,
            id: r.id,
            klass,
            recclass: r.recclass,
            year: yr,
            month: hasRealDate ? dM : null,
            day: hasRealDate ? dD : null,
            mass: isFinite(mass) ? mass : null,
            fall: r.fall,
            lat,
            lng,
          })
          if (yr < minYear) minYear = yr
          if (yr > maxYear) maxYear = yr
        }
        setMeteorites(cleaned)
        setYearRange([minYear, maxYear])
        setYear(maxYear)
      })
  }, [])

  // On This Day:
  //   1) If any real-date records match today's month+day → show those.
  //   2) Otherwise, pick a deterministic "specimen of the day" by hashing today's
  //      date into the top-365 by mass — gives daily fresh content even though
  //      the dataset has only ~11 real dates.
  const todaysFalls = useMemo(() => {
    if (!meteorites) return []
    const now = new Date()
    const m = now.getMonth() + 1
    const d = now.getDate()
    const real = meteorites
      .filter((x) => x.month === m && x.day === d)
      .sort((a, b) => (b.mass || 0) - (a.mass || 0))
    if (real.length > 0) return { kind: 'real', items: real }
    // fallback: pick one deterministically from the top 365 by mass
    const topByMass = [...meteorites]
      .sort((a, b) => (b.mass || 0) - (a.mass || 0))
      .slice(0, 365)
    const dayOfYear = Math.floor(
      (now - new Date(now.getFullYear(), 0, 0)) / 86400000
    )
    const pick = topByMass[(dayOfYear - 1 + topByMass.length) % topByMass.length]
    return { kind: 'pick', items: [pick] }
  }, [meteorites])

  // search results — name match, top 8, prefix-first then contains
  const searchResults = useMemo(() => {
    if (!meteorites || !searchQuery.trim()) return []
    const q = searchQuery.trim().toLowerCase()
    const prefix = []
    const contains = []
    for (const m of meteorites) {
      const name = m.name.toLowerCase()
      if (name.startsWith(q)) prefix.push(m)
      else if (name.includes(q)) contains.push(m)
      if (prefix.length >= 8) break
    }
    // prefix first, then contains, sorted within each by mass desc
    prefix.sort((a, b) => (b.mass || 0) - (a.mass || 0))
    contains.sort((a, b) => (b.mass || 0) - (a.mass || 0))
    return [...prefix, ...contains].slice(0, 8)
  }, [meteorites, searchQuery])

  // visible subset (year + class filter)
  const visiblePoints = useMemo(() => {
    if (!meteorites) return []
    return meteorites.filter((m) => m.year <= year && activeClasses[m.klass])
  }, [meteorites, year, activeClasses])

  // Global hero list — top HERO_COUNT by mass over the WHOLE catalog (not
  // year-filtered). These are the "named monuments" — Hoba, Cape York etc.
  // Hero membership stays stable across year scrubs; visibility is gated
  // separately so each hero appears at its actual fall year.
  const globalHeroes = useMemo(() => {
    if (!meteorites) return []
    return [...meteorites]
      .sort((a, b) => (b.mass || 0) - (a.mass || 0))
      .slice(0, HERO_COUNT)
  }, [meteorites])

  // Stratified split:
  //   hero = global top HERO_COUNT, year-gated and class-filtered
  //   mid  = all other visible (year-filtered) meteorites
  const { heroPoints, midPoints } = useMemo(() => {
    const heroSet = new Set(globalHeroes.map((m) => m.id))
    const heroVisible = globalHeroes.filter(
      (m) => m.year <= year && activeClasses[m.klass]
    )
    const mid = visiblePoints.filter((m) => !heroSet.has(m.id))
    return { heroPoints: heroVisible, midPoints: mid }
  }, [globalHeroes, visiblePoints, year, activeClasses])

  // Density data for the surface heatmap base layer.
  // KDE is O(N × surface tiles × bandwidth²) — 32k points hangs the page.
  // We downsample by random-keeping ~1/16 (≈ 2k pts) which preserves visible
  // density patterns while letting the KDE finish in <500ms.
  const heatmapData = useMemo(() => {
    if (!visiblePoints.length) return [[]]
    const step = Math.max(1, Math.ceil(visiblePoints.length / 2000))
    const sampled = []
    for (let i = 0; i < visiblePoints.length; i += step) {
      const m = visiblePoints[i]
      sampled.push({ lat: m.lat, lng: m.lng, weight: 1 })
    }
    return [sampled]
  }, [visiblePoints])

  // Particle sets for the mid tier — split by class so legend is honest.
  // P0.2 fix: previously split by era → all sprites amber → legend's 6 class
  // colors lied. Now grouped by CLASS_ORDER (rarest first → rendered last so
  // they sit on top under bloom). Era encoding is now carried by hero arrival
  // chronology + the time slider, not sprite color.
  const particleSets = useMemo(() => {
    if (!midPoints.length) return [[]]
    const buckets = Object.fromEntries(CLASS_ORDER.map((k) => [k, []]))
    for (const m of midPoints) {
      const k = m.klass && buckets[m.klass] ? m.klass : 'ordinary-chondrite'
      buckets[k].push(m)
    }
    // Render order: most-common first (back), rarest last (front under bloom).
    return [...CLASS_ORDER].reverse().map((k) => buckets[k])
  }, [midPoints])

  // Hero cones (custom layer) — replaces built-in pointsData for hero tier.
  // Single sentinel with payload; customThreeObject rebuilds InstancedMesh.
  const heroConeData = useMemo(() => {
    if (fwm === 'active' || fwm === 'closing') return []
    return [{ id: 'hero-cones', heroes: heroPoints, paletteName }]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroPoints, paletteName, fwm])

  // Hero fall-in animation state — per-instance start times so multiple
  // arrivals during meteor-rain don't reset each other.
  const heroMeshRef = useRef(null)
  const fallAnimRef = useRef({
    prevIds: new Set(),
    inFlight: new Map(),  // id → spawnTime
    heroes: [],
    flashRings: [],
  })

  // Force ringsData re-render when transient flash rings expire
  const [flashTick, forceFlashTick] = useState(0)

  // Single raf loop. Each in-flight hero falls from sky (altitude 1.5) to the
  // surface (0.005) over FALL_MS, easing out so it slows on approach.
  // Per-instance timing — multiple arrivals can stack mid-flight.
  useEffect(() => {
    let raf = 0
    const Y_AXIS = new THREE.Vector3(0, 1, 0)
    const tmpMat = new THREE.Matrix4()
    const tmpQuat = new THREE.Quaternion()
    const tmpScale = new THREE.Vector3()
    const FALL_MS = 1500
    const SKY_ALT = 1.5     // 1.5 globe radii above center
    const GROUND_ALT = 0.005

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const anim = fallAnimRef.current
      const mesh = heroMeshRef.current
      if (!mesh || anim.inFlight.size === 0) return
      const now = performance.now()
      const heroes = anim.heroes
      const completedIds = []
      anim.inFlight.forEach((spawnTime, id) => {
        const t = Math.min(1, (now - spawnTime) / FALL_MS)
        // ease-out cubic — fast fall, slow approach
        const eased = 1 - Math.pow(1 - t, 3)
        // current altitude lerps from SKY → GROUND
        const alt = SKY_ALT + (GROUND_ALT - SKY_ALT) * eased
        // find this hero's current instance index
        const idx = heroes.findIndex((h) => h.id === id)
        if (idx < 0) {
          completedIds.push(id)
          return
        }
        const d = heroes[idx]
        const pos = polar2cart(d.lat, d.lng, alt)
        const dir = pos.clone().normalize()
        tmpQuat.setFromUnitVectors(Y_AXIS, dir)
        const finalHeight = massToPillarHeight(d.mass)
        const radius = CLASS_RADIUS[d.klass] ?? 0.24
        // slight final-frame overshoot squish — landing pop
        const yScale = t > 0.95 ? finalHeight * (1 + (1 - t) * 4 * 0.06) : finalHeight
        tmpScale.set(radius, yScale, radius)
        tmpMat.compose(pos, tmpQuat, tmpScale)
        mesh.setMatrixAt(idx, tmpMat)
        if (t >= 1) completedIds.push(id)
      })
      mesh.instanceMatrix.needsUpdate = true
      for (const id of completedIds) anim.inFlight.delete(id)
      if (completedIds.length > 0) forceFlashTick((n) => n + 1)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Periodically prune expired flash rings (cheap — ~3/sec)
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now()
      const before = fallAnimRef.current.flashRings?.length || 0
      if (!before) return
      fallAnimRef.current.flashRings = fallAnimRef.current.flashRings.filter(
        (r) => r.expireAt > now
      )
      if (fallAnimRef.current.flashRings.length !== before) {
        forceFlashTick((n) => n + 1)
      }
    }, 300)
    return () => clearInterval(id)
  }, [])

  // Singleton sprite glow texture
  const glowTexture = useMemo(() => makeGlowTexture(), [])

  // class counts
  const classCounts = useMemo(() => {
    const out = Object.fromEntries(CLASS_ORDER.map((k) => [k, 0]))
    if (!meteorites) return out
    for (const m of meteorites) {
      if (m.year <= year) out[m.klass] += 1
    }
    return out
  }, [meteorites, year])

  // BLOOM post-processing — wire into react-globe.gl's exposed composer.
  // For daylight palettes (3-expert consensus says kill bloom), strength=0.
  const bloomRef = useRef(null)
  useEffect(() => {
    if (!globeRef.current) return
    const composer = globeRef.current.postProcessingComposer?.()
    if (!composer) return
    if (!bloomRef.current) {
      bloomRef.current = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.55, 0.42, 0.50
      )
      composer.addPass(bloomRef.current)
      const onResize = () =>
        bloomRef.current.setSize(window.innerWidth, window.innerHeight)
      window.addEventListener('resize', onResize)
    }
  }, [meteorites])

  // Toggle bloom strength based on palette
  useEffect(() => {
    if (!bloomRef.current) return
    bloomRef.current.strength = palette.bloomEnabled === false ? 0 : 0.55
  }, [paletteName, palette])

  // Apply globeTint via globeMaterial().color — but during FWM the globe
  // should fade up FROM black, not snap on. Producer's spec.
  // - fwm 'active'  → globe is dark (#0a0810), invisible behind the overlay
  // - fwm 'closing' → smoothly lerp from dark → palette tint over the closing window
  // - fwm 'done'    → palette tint, no animation
  useEffect(() => {
    if (!globeRef.current) return
    const mat = globeRef.current.globeMaterial?.()
    if (!mat) return
    const targetColor = new THREE.Color(palette.globeTint || '#FFFFFF')
    const darkColor = new THREE.Color('#0a0810')

    if (fwm === 'active') {
      mat.color = darkColor.clone()
      mat.needsUpdate = true
      return
    }
    if (fwm !== 'closing') {
      // 'check' or 'done' — apply final tint immediately
      mat.color = targetColor
      mat.needsUpdate = true
      return
    }
    // 'closing' — animate dark → target across closing+fade window.
    const start = performance.now()
    const duration = FWM_TIMING.closingMs + FWM_TIMING.fadeMs
    let raf = 0
    const tick = () => {
      const elapsed = performance.now() - start
      const t = Math.min(1, elapsed / duration)
      // ease-out cubic — most of the brighten happens late (revelation feel)
      const eased = 1 - Math.pow(1 - t, 3)
      mat.color = darkColor.clone().lerp(targetColor, eased)
      mat.needsUpdate = true
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [paletteName, palette, meteorites, fwm])

  // controls
  useEffect(() => {
    if (!globeRef.current) return
    const ctrl = globeRef.current.controls()
    ctrl.autoRotate = true
    ctrl.autoRotateSpeed = 0.18
    ctrl.enableDamping = true
    ctrl.dampingFactor = 0.08
    ctrl.minPolarAngle = Math.PI / 3.5
    ctrl.maxPolarAngle = Math.PI - Math.PI / 3.5
    ctrl.minDistance = 180
    ctrl.maxDistance = 500
    let resumeTimer = null
    const pause = () => {
      ctrl.autoRotate = false
      if (resumeTimer) clearTimeout(resumeTimer)
    }
    const queueResume = () => {
      if (resumeTimer) clearTimeout(resumeTimer)
      resumeTimer = setTimeout(() => { ctrl.autoRotate = true }, 3500)
    }
    ctrl.addEventListener('start', pause)
    ctrl.addEventListener('end', queueResume)
    return () => {
      ctrl.removeEventListener('start', pause)
      ctrl.removeEventListener('end', queueResume)
      if (resumeTimer) clearTimeout(resumeTimer)
    }
  }, [meteorites])

  // Pixel-space nearest-meteorite — Engineer's recommendation.
  // Project each visible specimen to screen-space, find within ~14px radius.
  // Scales naturally with zoom; matches what the user sees.
  const findNearestPixel = (clientX, clientY, radiusPx = 14) => {
    if (!meteorites || !globeRef.current) return null
    const renderer = globeRef.current.renderer?.()
    const camera = globeRef.current.camera?.()
    if (!renderer || !camera) return null
    const rect = renderer.domElement.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const v = new THREE.Vector3()
    let best = null
    let bestD2 = radiusPx * radiusPx
    for (const m of meteorites) {
      if (!activeClasses[m.klass]) continue
      if (m.year > year) continue
      // lat/lng → unit-radius cartesian on globe (R = 100 in three-globe)
      const phi = ((90 - m.lat) * Math.PI) / 180
      const theta = ((90 - m.lng) * Math.PI) / 180
      v.set(
        100 * Math.sin(phi) * Math.cos(theta),
        100 * Math.cos(phi),
        100 * Math.sin(phi) * Math.sin(theta)
      )
      v.project(camera)
      if (v.z > 1) continue // behind the globe / outside frustum
      const sx = ((v.x + 1) / 2) * rect.width
      const sy = ((1 - v.y) / 2) * rect.height
      const d2 = (sx - px) ** 2 + (sy - py) ** 2
      if (d2 < bestD2) {
        bestD2 = d2
        best = m
      }
    }
    return best
  }

  // onGlobeClick gives us {lat,lng}, but we need the original event for pixel coords.
  // react-globe.gl passes (coords, event) — we'll use the event's clientX/Y.
  const onGlobeClickHandler = (_coords, event) => {
    if (!event) return
    // bumped threshold to 24px for forgiving clicks on tiny mid-tier sprites
    const m = findNearestPixel(event.clientX, event.clientY, 24)
    if (m) openDossier(m)
  }

  // Fallback click on the renderer canvas — onGlobeClick only fires when the
  // ray hits the GLOBE SPHERE; clicks on sprites floating slightly above
  // surface, or on the bloom halo, may miss the sphere raycast and fall through.
  // This handler catches those misses.
  useEffect(() => {
    if (!meteorites || !globeRef.current) return
    const renderer = globeRef.current.renderer?.()
    if (!renderer) return
    const dom = renderer.domElement
    let downX = 0, downY = 0, downT = 0
    const onDown = (e) => { downX = e.clientX; downY = e.clientY; downT = performance.now() }
    const onUp = (e) => {
      const dx = e.clientX - downX, dy = e.clientY - downY
      const dt = performance.now() - downT
      // ignore drags (>4px or >300ms = camera rotation, not click)
      if (dx*dx + dy*dy > 16 || dt > 300) return
      const m = findNearestPixel(e.clientX, e.clientY, 24)
      if (m) openDossier(m)
    }
    dom.addEventListener('pointerdown', onDown)
    dom.addEventListener('pointerup', onUp)
    return () => {
      dom.removeEventListener('pointerdown', onDown)
      dom.removeEventListener('pointerup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meteorites, year, activeClasses])

  // mousemove → cursor pointer feedback when hovering near a clickable specimen
  useEffect(() => {
    if (!meteorites || !globeRef.current) return
    const renderer = globeRef.current.renderer?.()
    if (!renderer) return
    const dom = renderer.domElement
    let lastT = 0
    let raf = 0
    const onMove = (e) => {
      const now = performance.now()
      if (now - lastT < 33) return // ~30fps throttle
      lastT = now
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const m = findNearestPixel(e.clientX, e.clientY, 16)
        dom.style.cursor = m ? 'pointer' : ''
      })
    }
    dom.addEventListener('mousemove', onMove)
    return () => {
      dom.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
      dom.style.cursor = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meteorites, year, activeClasses])

  // B (zoom-triggered region banner): track which region the camera is currently
  // looking at when zoomed close. Updates a state for the floating banner.
  const [zoomRegion, setZoomRegion] = useState(null)
  useEffect(() => {
    if (!globeRef.current) return
    const ctrl = globeRef.current.controls?.()
    if (!ctrl) return
    const tick = () => {
      const camera = globeRef.current?.camera?.()
      if (!camera) return
      const dist = camera.position.length() // distance from globe center
      // Only show banner when zoomed in (camera < 280 from globe center)
      if (dist > 280) {
        setZoomRegion((cur) => (cur ? null : cur))
        return
      }
      // What lat/lng is the camera looking at? Approximate via inverted camera
      // direction projected onto unit sphere.
      const forward = new THREE.Vector3()
      camera.getWorldDirection(forward)
      const lookAt = camera.position.clone().add(forward.multiplyScalar(camera.position.length())).normalize()
      const lat = (Math.PI / 2 - Math.acos(lookAt.y)) * (180 / Math.PI)
      const lng = (Math.atan2(lookAt.z, lookAt.x) * 180) / Math.PI - 90
      const lngNorm = ((lng + 540) % 360) - 180
      const region = REGIONS.find((r) => {
        const dLat = lat - r.center.lat
        const dLng = lngNorm - r.center.lng
        return dLat * dLat + dLng * dLng < 30 * 30
      })
      setZoomRegion((cur) => (cur && region && cur.id === region.id ? cur : region || null))
    }
    ctrl.addEventListener('change', tick)
    return () => ctrl.removeEventListener('change', tick)
  }, [meteorites])

  const openDossier = (d) => {
    if (!d || !globeRef.current) return
    globeRef.current.pointOfView({ lat: d.lat, lng: d.lng, altitude: 1.2 }, 1100)
    setSelected(d)
    setHover(null)
    const slug = nameSlug(d.name)
    const url = new URL(window.location)
    url.searchParams.set('m', slug)
    window.history.replaceState(null, '', url)
  }

  const closeDossier = () => {
    setSelected(null)
    const url = new URL(window.location)
    url.searchParams.delete('m')
    window.history.replaceState(null, '', url)
  }

  // open from URL deep-link
  useEffect(() => {
    if (!meteorites) return
    const slug = new URL(window.location).searchParams.get('m')
    if (!slug) return
    const match = meteorites.find((m) => nameSlug(m.name) === slug)
    if (match) setTimeout(() => openDossier(match), 400)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meteorites])

  // close sidebar on Esc
  useEffect(() => {
    if (!selected) return
    const onKey = (e) => { if (e.key === 'Escape') closeDossier() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  // METEOR RAIN — auto-advance the timeline
  useEffect(() => {
    if (!isPlaying || !meteorites) return
    const [yMin, yMax] = yearRange
    const TICK_MS = 32
    const PAUSE_MS = 1500
    let yearLocal = year >= yMax ? yMin : year
    setYear(yearLocal)
    let timer = null
    const advance = () => {
      yearLocal += 1
      if (yearLocal > yMax) {
        setYear(yMin)
        yearLocal = yMin
        timer = setTimeout(advance, PAUSE_MS)
        return
      }
      setYear(yearLocal)
      timer = setTimeout(advance, TICK_MS)
    }
    timer = setTimeout(advance, TICK_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, meteorites, yearRange])

  const stopRain = () => setIsPlaying(false)

  const onPointHover = (d, prev) => {
    if (!d) {
      setHover(null)
      return
    }
    setHover((p) => (p && p.d === d ? p : { d, x: p?.x, y: p?.y }))
  }

  // track mouse position for hover card
  useEffect(() => {
    if (!hover) return
    const move = (e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))
    window.addEventListener('mousemove', move)
    return () => window.removeEventListener('mousemove', move)
  }, [Boolean(hover)])

  const toggleClass = (k, e) => {
    // Shift-click → solo (isolate this class). Plain click → toggle.
    // Solo-when-already-soloed → restore all (so Shift-click is reversible).
    if (e && e.shiftKey) {
      setActiveClasses((a) => {
        const allActive = CLASS_ORDER.every((c) => a[c])
        const onlyThis = CLASS_ORDER.every((c) => a[c] === (c === k))
        if (onlyThis) {
          return Object.fromEntries(CLASS_ORDER.map((c) => [c, true]))
        }
        return Object.fromEntries(CLASS_ORDER.map((c) => [c, c === k]))
      })
      return
    }
    setActiveClasses((a) => ({ ...a, [k]: !a[k] }))
  }
  const setAllClasses = (val) =>
    setActiveClasses(Object.fromEntries(CLASS_ORDER.map((k) => [k, val])))

  // Rings layer: during FWM = accumulated witness marks; otherwise = selected
  // impact ripple PLUS any transient hero-arrival flash rings.
  const ringsData = useMemo(() => {
    if (fwm === 'active' || fwm === 'closing') {
      const upto = fwm === 'closing' ? FIRST_WITNESSES.length : Math.min(fwmIdx + 1, FIRST_WITNESSES.length)
      return FIRST_WITNESSES.slice(0, upto).map((w, i) => ({
        lat: w.lat, lng: w.lng,
        maxR: 5.5,
        propagationSpeed: 1.4,
        repeatPeriod: 2400,
        intensity: i === upto - 1 ? 1.0 : 0.55,
      }))
    }
    const out = []
    if (selected) {
      out.push({
        lat: selected.lat, lng: selected.lng,
        maxR: 6,
        propagationSpeed: -3,
        repeatPeriod: 2400,
        intensity: 1.0,
      })
    }
    // hero-arrival flash rings — appear AT impact (after the fall), fade out
    const flashes = fallAnimRef.current?.flashRings || []
    const now = performance.now()
    for (const f of flashes) {
      // skip rings that haven't impacted yet
      if (now < f.impactAt) continue
      const remaining = f.expireAt - now
      if (remaining > 0) {
        out.push({
          lat: f.lat, lng: f.lng,
          maxR: 4,
          propagationSpeed: 4,
          repeatPeriod: 9999,
          intensity: Math.min(1, remaining / 1500),
        })
      }
    }
    return out
  }, [selected, fwm, fwmIdx, flashTick])

  const fwmActive = fwm === 'active' || fwm === 'closing'

  // 3D labels — only the hovered specimen name pinned at column top.
  // (Always-visible witness halos were removed by 4-agent vote — moved to
  // corner annotation [C], dossier provenance [E], zoom-triggered banner [B].)
  const allLabels = useMemo(() => {
    if (!hover || !hover.d) return []
    return [{
      lat: hover.d.lat,
      lng: hover.d.lng,
      text: hover.d.name,
      altitude: massToAltitude(hover.d.mass) * MAX_ALT_R + 0.008,
      size: 0.8,
      color: 'rgba(232, 225, 205, 0.9)',
    }]
  }, [hover])

  const totalShown = visiblePoints.length
  const totalAll = meteorites ? meteorites.length : 0

  return (
    <div className="stage">
      {meteorites === null && (
        <div className="loading">
          <div className="pulse" />
          Cataloging specimens
        </div>
      )}

      {fwmActive && (
        <FirstWitnessOverlay
          stage={fwm}
          idx={fwmIdx}
          onSkip={skipFwm}
        />
      )}

      <div className="scene-globe">
        <Globe
          ref={globeRef}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          showGlobe
          showAtmosphere
          atmosphereColor={palette.atmosphereColor}
          atmosphereAltitude={0.12}
          globeImageUrl={palette.globeImageUrl}
          bumpImageUrl={palette.bumpImageUrl}
          onGlobeClick={onGlobeClickHandler}
          /* etched amber coastlines (hidden during FWM for clean dark globe) */
          polygonsData={fwmActive ? [] : (countries || [])}
          polygonAltitude={0.006}
          polygonCapColor={() => palette.coastlineCap}
          polygonSideColor={() => palette.coastlineSide}
          polygonStrokeColor={() => palette.coastlineStroke}
          /* HERO TIER: top-50 mass plinth cones (custom InstancedMesh).
             4-dim encoding: height=mass, radius=class, color=fall, bloom=auto */
          customLayerData={heroConeData}
          customThreeObject={(d) => {
            // Detect newly-entered heroes (year scrub forward).
            const prev = fallAnimRef.current.prevIds
            const newIds = new Set()
            for (const h of d.heroes) {
              if (!prev.has(h.id)) newIds.add(h.id)
            }
            const isFirstBuild = prev.size === 0
            const animateIds = (isFirstBuild || newIds.size === 0) ? null : newIds

            // Always update heroes snapshot — raf loop reads .heroes per frame.
            fallAnimRef.current.heroes = d.heroes
            fallAnimRef.current.prevIds = new Set(d.heroes.map((h) => h.id))

            if (animateIds) {
              const now = performance.now()
              // Register each new arrival with its own spawn time (per-instance).
              for (const id of animateIds) {
                fallAnimRef.current.inFlight.set(id, now)
              }
              // Schedule flash ring at IMPACT moment (after FALL_MS), not now.
              const expireAt = now + 1500 + 1500 // impact at +1500, fade to +3000
              const impactAt = now + 1500
              const flashes = []
              for (const h of d.heroes) {
                if (animateIds.has(h.id)) {
                  flashes.push({ lat: h.lat, lng: h.lng, impactAt, expireAt })
                }
              }
              fallAnimRef.current.flashRings = [
                ...(fallAnimRef.current.flashRings || []).filter(r => r.expireAt > now),
                ...flashes,
              ]
              forceFlashTick((n) => n + 1)
            }

            // Dispose previous mesh's GPU resources before swapping.
            // three-globe rebuilds the custom layer on every customLayerData
            // change; without this, geometry+material accumulate in GPU memory.
            const prevMesh = heroMeshRef.current
            if (prevMesh) {
              if (prevMesh.geometry) prevMesh.geometry.dispose()
              if (prevMesh.material) {
                if (Array.isArray(prevMesh.material)) {
                  prevMesh.material.forEach((m) => m.dispose())
                } else {
                  prevMesh.material.dispose()
                }
              }
            }

            const mesh = buildHeroCones(d.heroes, palette, animateIds)
            heroMeshRef.current = mesh
            return mesh
          }}
          customThreeObjectUpdate={() => {}}
          /* MID TIER: ~32k specimens, grouped by class (P0.2). Order is
             reverse-CLASS_ORDER → commons first (back), rarest last (front).
             Color matches the legend swatches, so what user sees == what
             legend says. */
          particlesData={fwmActive ? [[]] : particleSets}
          particlesList={(d) => d}
          particleLat="lat"
          particleLng="lng"
          particleAltitude={(d) => Math.max(0.005, massToAltitude(d.mass) * MAX_ALT_R * 0.4)}
          particlesSize={(set, idx) => {
            // Rarer classes (rendered later, larger idx) get a small size bump
            // so they read through the chondrite carpet under bloom.
            const klass = [...CLASS_ORDER].reverse()[idx]
            const rare = klass === 'planetary' || klass === 'stony-iron'
            return rare ? 2.2 : 1.7
          }}
          particlesSizeAttenuation={true}
          particlesTexture={glowTexture}
          particlesColor={(set, idx) => {
            const klass = [...CLASS_ORDER].reverse()[idx]
            return CLASS_COLORS[klass] || (palette.particleColor || PARTICLE_AMBER)
          }}
          /* BASE TIER: heatmap temporarily disabled — KDE perf issue at 32k.
             TODO: investigate hexBin alternative or reduce bandwidth. */
          /* Rings layer — inward-propagating "impact ripple" on selected */
          ringsData={ringsData}
          ringColor={(d) => (t) => {
            // During FWM, override palette color → amber-cream so marks pop on black globe.
            // Multiply by intensity so older rings are dimmer than the newest.
            const base = (fwm === 'active' || fwm === 'closing')
              ? 'rgba(248, 230, 175, ALPHA)' /* warm cream amber */
              : palette.ringColor
            const intensity = (d && d.intensity) || 1.0
            return base.replace('ALPHA', String((1 - t) * intensity))
          }}
          ringMaxRadius="maxR"
          ringPropagationSpeed="propagationSpeed"
          ringRepeatPeriod="repeatPeriod"
          ringAltitude={0.005}
          /* Labels: witness halos + hovered specimen pinned to column top */
          labelsData={allLabels}
          labelLat="lat"
          labelLng="lng"
          labelText="text"
          labelSize={(l) => l.size}
          labelAltitude={(l) => l.altitude}
          labelColor={(l) => l.color}
          labelResolution={3}
          labelIncludeDot={false}
        />
      </div>

      <header className="masthead">
        <div className="title">
          <h1>
            FALLING STARS<em>陨星档案</em>
          </h1>
        </div>

        <div className="search">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchResults[0]) {
                openDossier(searchResults[0])
                setSearchQuery('')
              } else if (e.key === 'Escape') {
                setSearchQuery('')
              }
            }}
            placeholder="search the archive…"
            aria-label="Search meteorites by name"
          />
          {searchResults.length > 0 && (
            <ul className="search-results" role="listbox">
              {searchResults.map((m) => (
                <li
                  key={m.id}
                  role="option"
                  onClick={() => {
                    openDossier(m)
                    setSearchQuery('')
                  }}
                >
                  <span className="sr-name">{m.name}</span>
                  <span className="sr-meta">
                    <span className="sr-year num">{m.year}</span>
                    <span className="sr-mass num">
                      {m.mass != null ? formatMass(m.mass) : '—'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="meta">
          <span className="num">{totalShown.toLocaleString()}</span> /{' '}
          <span className="num">{totalAll.toLocaleString()}</span> &nbsp;·&nbsp; NASA
          Meteoritical Bulletin
          <button className="fwm-replay" onClick={replayFwm} title="Replay opening">
            Intro
          </button>
        </div>
      </header>

      {/* MODE SWITCHER — names only, no explanation. Let users discover. */}
      <div className="mode-switcher">
        {Object.entries(PALETTES).map(([key, p]) => (
          <button
            key={key}
            className={`ms-btn ${paletteName === key ? 'on' : ''}`}
            onClick={() => setPaletteName(key)}
            title={p.sub /* tooltip only — no inline explainer */}
          >
            <span className="ms-name">{p.name}</span>
          </button>
        ))}
      </div>

      <aside className="legend">
        {CLASS_ORDER.map((k) => (
          <div
            key={k}
            className={`row ${activeClasses[k] ? 'active' : 'dim'}`}
            onClick={(e) => toggleClass(k, e)}
            role="button"
            title={`${CLASS_LABELS[k]}\nClick: toggle · Shift+Click: solo`}
          >
            <span className="count num">{classCounts[k].toLocaleString()}</span>
            {CLASS_LABELS_SHORT[k]}
            <span className="swatch" style={{ color: POINT_COLORS[k], background: POINT_COLORS[k] }} />
          </div>
        ))}
        <div className="legend-actions">
          <button
            className="legend-action"
            onClick={() => setAllClasses(true)}
            title="Show all classes"
          >All</button>
          <span className="legend-hint">Shift+Click row to solo</span>
        </div>
      </aside>

      <footer className="timeline">
        <div className="line">
          <span>{yearRange[0]}</span>
          <span className="now">№ {year}</span>
          <span>{yearRange[1]}</span>
        </div>
        <div className="track-row">
          <button
            className={`play ${isPlaying ? 'on' : ''}`}
            onClick={() => setIsPlaying((p) => !p)}
            aria-label={isPlaying ? 'Pause meteor rain' : 'Play meteor rain'}
            title={isPlaying ? 'Pause' : 'Meteor rain'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <input
            type="range"
            min={yearRange[0]}
            max={yearRange[1]}
            step={1}
            value={year}
            onChange={(e) => { stopRain(); setYear(parseInt(e.target.value, 10)) }}
          />
        </div>
      </footer>

      {hover && hover.x != null && !selected && (
        <div className="specimen" style={{ left: hover.x, top: hover.y }}>
          <div className="tag-id">
            FALL № {String(hover.d.id || '00000').padStart(5, '0')} · {hover.d.year}
          </div>
          <div className="tag-name">{hover.d.name}</div>
          <div className="hint">Click to open dossier</div>
        </div>
      )}

      {/* C: corner annotation — clickable region wayfinding */}
      <nav className="dense-fields" aria-label="Dense find regions">
        <div className="dense-fields-label">Dense Fields</div>
        {REGIONS.map((r) => (
          <button
            key={r.id}
            className="dense-fields-btn"
            onClick={() => {
              if (!globeRef.current) return
              globeRef.current.pointOfView(
                { lat: r.center.lat, lng: r.center.lng, altitude: 0.85 },
                1400
              )
            }}
            title={r.full + ' — ' + r.note}
          >
            {r.short}
          </button>
        ))}
      </nav>

      {/* On This Day — calendar matches when available, otherwise a daily pick */}
      {!fwmActive && !selected && todaysFalls.items?.length > 0 && (
        <aside className="otd">
          <div className="otd-label">
            {todaysFalls.kind === 'real' ? 'On This Day' : 'Specimen of the Day'}
            <span className="otd-date"> · {formatToday()}</span>
          </div>
          <ul>
            {todaysFalls.items.slice(0, 3).map((m) => (
              <li key={m.id} onClick={() => openDossier(m)}>
                <span className="otd-name">{m.name}</span>
                <span className="otd-year num">{m.year}</span>
              </li>
            ))}
            {todaysFalls.items.length > 3 && (
              <li className="otd-more">+ {todaysFalls.items.length - 3} more</li>
            )}
          </ul>
        </aside>
      )}

      {/* B: zoom-triggered region banner — appears when camera flies into a region */}
      {zoomRegion && !selected && (
        <div className="zoom-banner">
          <div className="zoom-banner-id">{zoomRegion.short}</div>
          <div className="zoom-banner-full">{zoomRegion.full}</div>
          <div className="zoom-banner-note">{zoomRegion.note}</div>
        </div>
      )}

      {selected && <SpecimenDossier d={selected} onClose={closeDossier} />}
    </div>
  )
}

function witnessLineFor(d) {
  // Three states (P0.3 — Producer's "who knew?" thesis line):
  //   Fell   → witnessed
  //   Found, modern recovery (year ≥ 1900)        → recovered, no witness
  //   Found, ancient or undated (year < 1900 / —) → prehistoric, no witness
  if (d.fall === 'Fell') {
    return {
      eyebrow: 'Witnessed',
      body: `Observed falling. Someone on the ground in ${d.year || 'this year'} saw a star arrive.`,
    }
  }
  const y = d.year
  if (y && y >= 1900) {
    return {
      eyebrow: 'No witness',
      body: `Recovered ${y}. The fall itself went unseen — found later, in the field.`,
    }
  }
  return {
    eyebrow: 'No witness',
    body: y
      ? `Recovered ${y}. The fall predates any record of observation.`
      : 'Recovery date unknown. The fall predates any record of observation.',
  }
}

function SpecimenDossier({ d, onClose }) {
  const mbdUrl = `https://www.lpi.usra.edu/meteor/metbull.php?sea=${encodeURIComponent(d.name)}&sfor=names&stype=contains`
  const massComp = massComparison(d.mass)
  const provenance = regionFor(d) // E: bind region context to specimen click
  const witness = witnessLineFor(d)
  return (
    <div className="dossier" role="dialog" aria-label="Specimen dossier">
      <button className="dossier-close" onClick={onClose} aria-label="Close">
        <span aria-hidden>×</span>
      </button>
      <div className="dossier-id">FALL № {String(d.id || '00000').padStart(5, '0')}</div>
      <div className="dossier-name">{d.name}</div>
      <div className="dossier-year">{d.year}</div>
      <div className="dossier-rule" />
      <dl className="dossier-grid">
        <dt>Class</dt><dd>{d.recclass}</dd>
        <dt>Type</dt><dd>{CLASS_LABELS[d.klass]}</dd>
        <dt>Mass</dt>
        <dd>
          {d.mass != null ? formatMass(d.mass) : '—'}
          {massComp && <span className="mass-comp"> · {massComp}</span>}
        </dd>
        <dt>Fall</dt><dd>{d.fall}</dd>
        <dt>Coords</dt>
        <dd>
          {Math.abs(d.lat).toFixed(3)}° {d.lat >= 0 ? 'N' : 'S'},{' '}
          {Math.abs(d.lng).toFixed(3)}° {d.lng >= 0 ? 'E' : 'W'}
        </dd>
      </dl>
      <div className="dossier-rule" />
      <div className={`dossier-witness ${d.fall === 'Fell' ? 'witnessed' : 'unwitnessed'}`}>
        <div className="dossier-witness-eyebrow">{witness.eyebrow}</div>
        <div className="dossier-witness-body">{witness.body}</div>
      </div>
      {provenance && (
        <>
          <div className="dossier-rule" />
          <div className="dossier-provenance">
            <div className="dossier-prov-label">Provenance</div>
            <div className="dossier-prov-name">{provenance.full}</div>
            <div className="dossier-prov-note">{provenance.note}</div>
          </div>
        </>
      )}
      <div className="dossier-rule" />
      <a className="dossier-link" href={mbdUrl} target="_blank" rel="noreferrer">
        ↗ Meteoritical Bulletin Database
      </a>
      <div className="dossier-hint">Press Esc to close</div>
    </div>
  )
}

function Typewriter({ text, durationMs, onDone }) {
  const [out, setOut] = useState('')
  const [phase, setPhase] = useState('typing') // typing | done
  useEffect(() => {
    setOut('')
    setPhase('typing')
    if (!text) return
    let cancelled = false
    let i = 0
    const step = Math.max(18, durationMs / Math.max(text.length, 1))
    const interval = setInterval(() => {
      if (cancelled) return
      i += 1
      setOut(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(interval)
        setPhase('done')
        onDone?.()
      }
    }, step)
    return () => { cancelled = true; clearInterval(interval) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, durationMs])
  return <>{out}{phase === 'typing' && <span className="cursor">|</span>}</>
}

function FwmStanza({ witness }) {
  // strict sequential: meta → framing → quote
  const [step, setStep] = useState(0) // 0=meta, 1=framing, 2=quote
  // reset to 0 whenever witness changes
  useEffect(() => { setStep(0) }, [witness.id])
  return (
    <>
      <div className="fwm-meta">
        <Typewriter
          key={`meta-${witness.id}`}
          text={`${witness.year} · ${witness.place} · ${witness.name}`}
          durationMs={1200}
          onDone={() => setTimeout(() => setStep(1), FWM_TIMING.pauseMs)}
        />
      </div>
      <div className="fwm-framing">
        {step >= 1 && (
          <Typewriter
            key={`fr-${witness.id}`}
            text={witness.framing}
            durationMs={FWM_TIMING.framingMs}
            onDone={() => setTimeout(() => setStep(2), 300)}
          />
        )}
      </div>
      <div className="fwm-quote">
        {step >= 2 && (
          <Typewriter
            key={`q-${witness.id}`}
            text={`"${witness.quote}"`}
            durationMs={FWM_TIMING.quoteMs}
          />
        )}
      </div>
    </>
  )
}

function FirstWitnessOverlay({ stage, idx, onSkip }) {
  const isClosing = stage === 'closing'
  const witness = !isClosing && idx < FIRST_WITNESSES.length ? FIRST_WITNESSES[idx] : null

  const total = FIRST_WITNESSES.length
  const stepNum = isClosing ? total : Math.min(idx + 1, total)
  const progressPct = (stepNum / total) * 100

  return (
    <div className={`fwm ${isClosing ? 'closing' : ''}`}>
      <div className="fwm-progress" aria-hidden="true">
        <div className="fwm-progress-bar" style={{ width: `${progressPct}%` }} />
      </div>
      <div className="fwm-skip">
        <button onClick={onSkip} aria-label="Skip intro">
          <span className="fwm-skip-label">Skip Intro</span>
          <span className="fwm-skip-key">Esc</span>
        </button>
      </div>

      <div className="fwm-frame">
        {!isClosing && witness && (
          <>
            <div className="fwm-counter num">
              {String(idx + 1).padStart(2, '0')} / {String(FIRST_WITNESSES.length).padStart(2, '0')}
            </div>
            <FwmStanza witness={witness} />
          </>
        )}
        {isClosing && (
          <>
            <div className="fwm-counter num">07 / 07</div>
            <div className="fwm-closing">
              <Typewriter key="closing" text={FWM_CLOSING} durationMs={5500} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function massComparison(g) {
  if (g == null) return null
  if (g < 5) return 'a postage stamp'
  if (g < 50) return 'a peach pit'
  if (g < 500) return 'a tennis ball'
  if (g < 5000) return 'a cantaloupe'
  if (g < 50000) return 'a watermelon'
  if (g < 500000) return 'a bag of cement'
  if (g < 5e6) return 'a small car'
  if (g < 5e7) return 'a school bus'
  return 'a blue whale'
}

function nameSlug(name) {
  return name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
}

function formatToday() {
  const now = new Date()
  return now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

function formatMass(g) {
  if (g >= 1e6) return `${(g / 1e6).toFixed(2)} t`
  if (g >= 1e3) return `${(g / 1e3).toFixed(1)} kg`
  return `${g.toFixed(0)} g`
}
