// CSV parser — small, dependency-free, handles quoted fields with commas.
// CSV file uses CRLF line endings.

export function parseCsv(text) {
  const rows = []
  const lines = text.split(/\r\n|\n|\r/)
  if (!lines.length) return rows
  const headers = splitCsvLine(lines[0])
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const cols = splitCsvLine(line)
    const obj = {}
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cols[j]
    }
    rows.push(obj)
  }
  return rows
}

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else {
      if (c === ',') {
        out.push(cur)
        cur = ''
      } else if (c === '"') {
        inQuotes = true
      } else {
        cur += c
      }
    }
  }
  out.push(cur)
  return out
}

// Classify a NASA recclass string into one of 6 buckets — recommended by our
// meteoritics specialist. Improvement over the old 3-bucket scheme:
//   - 94% of records previously dumped into "Stone" — now resolved into
//     ordinary-chondrite vs carbonaceous-chondrite vs achondrite vs planetary
//   - Lunar / Martian (~600 specimens, the rarest, most clickable) are now
//     a 1st-class category instead of buried in "Stone"
//
// Order matters — match more-specific patterns first.
export function classifyMeteorite(recclass) {
  if (!recclass) return null
  const s = recclass.trim()
  const u = s.toUpperCase()

  // 1. Planetary — lunar + martian. Match BEFORE "achondrite" because Mars
  //    meteorites (Shergottite/Nakhlite/Chassignite, "SNC") are achondrites.
  if (/^(LUN|Lunar)/i.test(s)) return 'planetary'
  if (/^(Martian|Shergottite|Nakhlite|Chassignite|OPX)/i.test(s)) return 'planetary'

  // 2. Iron — match BEFORE stony-iron substring traps.
  if (/^Iron(\b|,|$)/i.test(s)) return 'iron'

  // 3. Stony-iron (pallasites + mesosiderites)
  if (/Pallasite|Mesosiderite/i.test(s)) return 'stony-iron'

  // 4. Carbonaceous chondrite: C followed by group letter (I/M/O/V/K/R/H/B/L)
  //    + optional petrologic digit, e.g. CV3, CM2, CK4, CBa
  if (/^C[IMOVKRHBL]?\d?[a-z]?(-|$|,)/i.test(s) || /^C\d/.test(u)) {
    return 'carbonaceous'
  }

  // 5. Other achondrites (differentiated, non-planetary). Eucrite/Howardite/
  //    Diogenite are the HED group (from Vesta — also a great story).
  if (/^(Eucrite|Diogenite|Howardite|Ureilite|Aubrite|Acapulcoite|Lodranite|Angrite|Brachinite|Winonaite|Achondrite)/i.test(s)) {
    return 'achondrite'
  }

  // 6. Ordinary chondrites (the giant majority): H/L/LL/EH/EL/R/K + digit
  if (/^(H|L|LL|EH|EL|R|K)\d/.test(u)) return 'ordinary-chondrite'
  if (/^(OC|Chondrite|Stone)/i.test(s)) return 'ordinary-chondrite'

  // Safe default — 94% prior on ordinary chondrite for unknown strings
  return 'ordinary-chondrite'
}

// Class colors — NEUTRAL placeholders for now. Phase 2.5+6.4 will encode
// fall=Fell vs fall=Found via luminance separately, and these colors will be
// re-tuned per palette in Phase 2.5+6.6.
export const CLASS_COLORS = {
  'ordinary-chondrite': '#A8957A',  // warm grey-tan (most common)
  'carbonaceous':       '#3D5C7A',  // deep cool blue (carbon-rich, primitive)
  'achondrite':         '#6E8C5C',  // muted olive (differentiated)
  'iron':               '#7C7670',  // metallic neutral
  'stony-iron':         '#9B6F4A',  // gold-rust (pallasites are gem-like)
  'planetary':          '#9D5482',  // muted magenta (rare — privileged)
}

export const CLASS_LABELS = {
  'ordinary-chondrite': 'Ordinary Chondrite · 普通球粒陨石',
  'carbonaceous':       'Carbonaceous Chondrite · 碳质球粒陨石',
  'achondrite':         'Achondrite · 无球粒陨石',
  'iron':               'Iron · 铁陨石',
  'stony-iron':         'Stony-iron · 石铁陨石',
  'planetary':          'Planetary (Lunar/Martian) · 月球/火星陨石',
}

// Short labels for legend / tight UI
export const CLASS_LABELS_SHORT = {
  'ordinary-chondrite': 'Chondrite',
  'carbonaceous':       'Carbonaceous',
  'achondrite':         'Achondrite',
  'iron':               'Iron',
  'stony-iron':         'Stony-iron',
  'planetary':          'Planetary',
}

// Display order (rarest → most common, so the rare ones get visual attention)
export const CLASS_ORDER = [
  'planetary',
  'stony-iron',
  'iron',
  'carbonaceous',
  'achondrite',
  'ordinary-chondrite',
]
