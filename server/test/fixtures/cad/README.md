# CAD fixtures

Small parts for the CAD plug-in's tests, all made by the scripts in this
folder for Scope Studio. Source: generated here, not taken from anywhere.
Licence: CC0 1.0 (public domain dedication).

| File | What it is | Made by |
|---|---|---|
| `cube.stl` | 10 mm cube, binary STL | `generate.mjs` |
| `cube-ascii.stl` | The same cube, ASCII STL | `generate.mjs` |
| `bracket.stl` | 60 × 20 × 5 mm plate with two 5 mm square holes whose centres are 40 mm apart, 5 mm from the edges | `generate.mjs` |
| `overlap-a.stl`, `overlap-b.stl` | Two 10 mm cubes, the second offset 5 mm on every axis (they interfere) | `generate.mjs` |
| `touching.stl` | A 10 mm cube flush against `overlap-a.stl` (touches, does not interfere) | `generate.mjs` |
| `inner.stl` | A 2 mm cube wholly inside `overlap-a.stl` | `generate.mjs` |
| `open-box.stl` | The 10 mm cube with its top face missing (not watertight) | `generate.mjs` |
| `bracket-assembly.step` | Hand-written STEP AP214 product structure: an assembly using a bracket once and an M4 bolt twice, in mm, no geometry | `generate.mjs` |
| `cube.step` | 10 mm cube B-rep exported by CadQuery / OCCT | `generate_step.py` |
| `two-boxes.step` | Two 10 mm boxes as two solids in one file, overlapping by 125 mm³ | `generate_step.py` |
| `two-boxes-apart.step` | The same boxes 20 mm apart | `generate_step.py` |
| `recorded.json` | CadQuery's answers to the requests the tests make, for machines without CadQuery | the tests, with `CAD_RECORD=1` |

`shapes.js` builds the meshes from grid cells, so every mesh is exactly
watertight; the tests also use it to build variants (an inside-out box, an
offset copy) without more files.

Regenerating, from `server/`:

```sh
node test/fixtures/cad/generate.mjs
python test/fixtures/cad/generate_step.py          # needs CadQuery
CAD_RECORD=1 CADQUERY_PYTHON=/path/to/venv/bin/python \
  node --test --test-concurrency=1 test/integration/cad*.test.js
```

The STL files and `bracket-assembly.step` come out byte-identical every time.
OCCT stamps the export time into the `.step` solids, so those differ by their
header only. `replay.js` keys recordings by request (mode, input names, flags
and the edit script), not by file contents, for the same reason.
