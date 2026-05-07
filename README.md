# Falling Stars · 陨星档案

> 31,956 个陨石都有人记下了名字。这是其中第 31,957 次记录——你的访问。

A 3D-globe archive of every meteorite recovery in the NASA Meteoritical
Bulletin Database. Each falling star is plotted at the spot it was found,
sized by mass, colored by classification, and tagged with the year it
arrived on Earth.

Three reading modes. One catalog. 31,956 names.

---

## What's inside

- **31,956 specimens** from the [NASA Meteoritical Bulletin Database](https://www.lpi.usra.edu/meteor/),
  filtered to those with verified lat/lng/year coordinates.
- **6 classification tiers**, ordered rarest → most common:
  *Planetary (Lunar / Martian)* · *Stony-iron* · *Iron* · *Carbonaceous* ·
  *Achondrite* · *Ordinary chondrite*.
- **Three palettes**:
  - **Atlas** — true daylight earth on cream paper. Cooper Hewitt mood.
  - **Sextant** — cool dark night earth + ember accents. NASA Eyes mood.
  - **Folio** — Cellarius 1660 *Harmonia Macrocosmica* — deep indigo plate
    field with gilt halo. Old celestial-atlas mood.
- **First Witness Mode** — a 7-stanza opening that leans into the seven
  oldest witnessed falls before opening the archive proper. Skippable.
- **Time scrub** from 1704 → 2025. Press play and watch the catalog fill in.
- **Provenance regions** for the dense find belts (ANSMET, Saharan, Pampa).
- **Specimen of the Day** — a deterministic-by-date pick from the top
  365 by mass, with full dossier on click.
- **Plate № notation** in Roman numerals for catalog IDs ≤ 3999, falling
  back to comma-formatted Arabic for the larger numbers.

## Visual technique

The hard part of plotting 31,956 points on a sphere is the long tail —
93% are ordinary chondrites, 0.5% are lunar/martian. Equal weight produces
either visual mold (everyone the same) or hidden rare specimens (linear
mass scaling). The recipe here is:

- **Datashader-style histogram-equalization on mass** — size mapped by
  rank percentile, not raw mass. The rare top 1% gets dramatically
  more screen real estate than they would on a log curve.
- **Per-class hard size caps** — a heavy chondrite (Allende is a 2-tonne
  chondrite!) cannot exceed 3.5px no matter what the eq_hist suggests.
  Chondrite stays "carpet"; rare classes are "stars".
- **Stellarium-style brightness LOD** — when the camera is far, small
  points dim to 18% of their alpha; as you zoom in they restore. The
  archive opens up as you approach.
- **Sharp PNG sprite + alphaTest 0.5** — copied from the three-globe
  satellites demo. No bloom. No additive blending. No breathing.
  31,956 points in one draw call.
- **Hand-tuned scene lighting** per palette, github-globe style.
  The "premium" feel comes from the globe surface, not from glow on
  the points.

If you're curious about the design history (Plan A → D → F all came
out of multi-agent design panels and user feedback), see the commit log
under `git log --oneline`. It's narrative.

## Local development

```bash
cd app
npm install
npm run dev      # http://localhost:5173 (or 5181 if launched via .claude/launch.json)
```

For a production build:

```bash
npm run build
npm run preview
```

To preview the production build with the GitHub Pages base path applied:

```bash
VITE_BASE=/falling-stars/ npm run build
npm run preview
```

## Stack

- React 19 + Vite 8
- [react-globe.gl](https://github.com/vasturiano/react-globe.gl) (which
  wraps three-globe and Three.js).
- Three.js InstancedMesh for the beacon pillars (top 1% by mass).
- Custom Three.js ShaderMaterial + Points for the 31,956-point archive layer.
- UnrealBloomPass for selective bloom (Sextant + Folio modes only).
- A small CSV parser in `src/data.js` — no dependency.

## Deployment

A GitHub Action (`.github/workflows/deploy.yml`) builds and publishes to
GitHub Pages on every push to `main`. The build uses
`VITE_BASE=/<repo-name>/` automatically, so forks just need to enable
Pages under repo settings → Pages → Source: GitHub Actions.

## Data & credits

- **Data:** [NASA Meteoritical Bulletin Database](https://www.lpi.usra.edu/meteor/),
  via the maintained mirror at [katebar/meteorite-landings](https://github.com/CaffeineViking/meteorite-landings).
- **Globe textures:** Public-domain Earth imagery from
  [vasturiano/three-globe](https://github.com/vasturiano/three-globe/tree/master/example/img)
  (Blue Marble + Black Marble + topology bumpmap).
- **Visualization:** Falling Stars · 陨星档案 · MMXXVI

## License

Code: MIT. Data: NASA / CC0. Globe textures: NASA / public domain.
