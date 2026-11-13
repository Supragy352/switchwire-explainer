# Switchwire, Part by Part

Interactive explainer for the Voron Switchwire, built from *The Mechanics of a Bed Slinger, Part by Part*
and its CAD figure supplement. Plain HTML/CSS/JS; three.js r147 and KaTeX load from CDNs.

## Run locally

```bash
python -I tools/serve.py 8765
```

Then open http://localhost:8765. The server wraps `index.html` in the same doctype/charset skeleton the
claude.ai Artifact host adds at publish time (KaTeX refuses to run in quirks mode).

## GitHub Pages

`.github/workflows/pages.yml` runs `python -I tools/serve.py --build _site` on every push to `main`
(same skeleton wrap as the local server) and deploys `_site`.

## Rebuild the 3D model

1. With the Switchwire assembly open in Fusion, run `tools/fusion_export_gltf.py` through the Fusion MCP
   script runner (or Fusion's Scripts dialog). It writes `switchwire.gltf` + `.bin` to the path in
   `SW_EXPORT_DIR` (default: `%TEMP%/switchwire-export`), colouring parts by name (`PALETTE`).
2. Pack it: `python -I tools/pack_glb.py <export>/switchwire.gltf models/switchwire.b64.txt`
   (int16/int8 quantization, gzip, base64; Artifacts serve no `.gz`/`.bin`).

## Files

- `index.html`: content, styles, KaTeX rendering, scroll-to-view sync
- `js/viewer.js`: model loading, axis poses, belts drawn from pulley positions, views, highlight, part picking
- `js/widgets.js`: CoreXZ driver, microstep, belt pluck, bed heat-up, wire drop, Y resonance, input shaper
- `models/switchwire.b64.txt`: the full CAD assembly (781 parts, ~730k triangles)
