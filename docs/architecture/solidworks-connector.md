# SolidWorks connector (design)

Status: design only. Nothing here is built. It describes how Scope Studio
would read and edit native SolidWorks parts and assemblies on a machine with
a licensed seat, so the decision to build it can be made on a concrete plan.

## Why a companion, and why separate

SolidWorks files (`.sldprt`, `.sldasm`, `.slddrw`) are proprietary. The only
supported way to read their feature tree, configurations and custom
properties, or to change a dimension and rebuild, is the SolidWorks API: a
COM interface exposed by a running `SLDWORKS.exe` on Windows, under the
user's own licence. The engine is Node on macOS and Linux as well as
Windows, never loads COM, and must not depend on a proprietary install. So
the connector is a separate Windows program, the **companion**, that runs
beside SolidWorks on the user's own machine and talks to the engine over
localhost. The engine treats it as a plug-in whose capabilities happen to be
carried out somewhere else.

The open-format path (`server/src/plugins/cad/`, STL and STEP, CadQuery in
the OS sandbox) stays the default and needs nothing from SolidWorks. The
companion adds what only SolidWorks can do: the parametric history.

```
 Scope engine (Node)                         Windows, same machine
 ┌────────────────────────────┐   HTTP on    ┌──────────────────────────┐   COM    ┌───────────────┐
 │ plugins/solidworks/        │  127.0.0.1   │ Scope SolidWorks         │ ───────▶ │ SLDWORKS.exe  │
 │  capabilities + verifiers  │ ───────────▶ │ companion (.NET 8)       │          │ (user licence)│
 │  can() decides first       │ ◀─────────── │ one job at a time        │ ◀─────── │               │
 └────────────────────────────┘   JSON       └──────────────────────────┘          └───────────────┘
```

## The companion

- A small .NET 8 Windows service-less app (tray icon), installed by the
  user, started on demand. It uses the SolidWorks interop assemblies that
  ship with SolidWorks (`SolidWorks.Interop.sldworks`, `swconst`); nothing
  of SolidWorks is redistributed.
- It attaches to a running SolidWorks (`GetActiveObject("SldWorks.Application")`)
  or starts one invisibly (`Visible = false`, `UserControl = false`) and
  quits only an instance it started.
- It runs one job at a time on the COM STA thread SolidWorks requires, with a
  per-job timeout. A job that times out is abandoned, the document closed
  without saving, and SolidWorks restarted if it stopped answering.
- It never opens a network port beyond the loopback listener below and makes
  no outbound connections.

## Talking to the engine

- **Transport**: HTTP/1.1 on `127.0.0.1` only, on a random port the
  companion chooses at start. It writes `{ port, pid, version }` to
  `%LOCALAPPDATA%\Scope Studio\solidworks-companion.json` (readable by the
  user only), where the engine finds it.
- **Pairing**: the first time, the engine shows a six-digit code that the
  user types into the companion's tray window. Each side then holds a
  32-byte random secret, stored with Windows DPAPI on the companion side and
  in the engine's existing local secret store on the other. The secret never
  appears in a URL, a log or a graph node.
- **Requests**: every request carries `Authorization: Bearer <secret>`, a
  fresh `X-Request-Id`, and `X-Timestamp`; the companion rejects a stale
  timestamp (more than 60 s off) or a repeated id. `Host` must be
  `127.0.0.1:<port>`, which stops a web page from reaching it by DNS
  rebinding, and the companion sends no CORS headers, so a browser cannot
  read its answers.
- **Shape**: `GET /v1/status` → `{ solidworks: { running, version, licence }, busy }`;
  `POST /v1/jobs` `{ capability, input }` → 202 `{ jobId }`;
  `GET /v1/jobs/:id` → `{ state, output?, error? }`. Errors use the engine's
  `{ error: '<code>', message }` with codes `not_paired`, `solidworks_not_running`,
  `licence_unavailable`, `file_locked`, `rebuild_failed`, `timeout`,
  `outside_project`, `invalid_input`.

## Capabilities

The engine side is a normal plug-in, `server/src/plugins/solidworks/`, tag
`solidworks` (a CAD Designer role adds the tag to use it). Its capabilities
mirror the CAD plug-in's so the planner and the verifiers work the same way,
and `can()` decides every call before the companion hears of it.

| Capability | Permission | What the companion does |
|---|---|---|
| `solidworks.inspect` | `read_graph` (source `solidworks`) | Opens the document read-only; returns the feature tree (names, types, suppressed state), configurations, custom properties, global variables and equations, driving dimensions (`D1@Sketch1` with value and unit), mass properties of the active configuration (`IMassProperty`), bounding box, and for an assembly its components with configuration and count. |
| `solidworks.mass_properties` | `read_graph` (source `solidworks`) | The same mass properties, with an optional material override for the calculation only. |
| `solidworks.interference` | `read_graph` (source `solidworks`) | Runs Interference Detection on an assembly (`IInterferenceDetectionMgr`), returns each interfering pair and its volume. |
| `solidworks.export` | `edit_files` | Saves a copy as STEP AP214/AP242 or STL into the run's sandbox copy, so the open-format plug-in and its verifiers can measure it. |
| `solidworks.set_dimensions` | `edit_files` | In a **copy** of the document in the run's sandbox: sets named dimensions or global variables, rebuilds (`ForceRebuild3`), reports rebuild errors, saves. The user's original is never written. |
| `solidworks.run_macro` | `run_generated_code` | Not offered. A model-written VBA or C# macro runs with the user's full rights inside SolidWorks, with no sandbox around it; the safety rules forbid that. Parametric changes go through `set_dimensions`, whose inputs are data. |

Verifiers reuse the CAD plug-in's on an export: after `set_dimensions` the
engine asks for a STEP or STL export of the rebuilt copy, then runs
`cad.valid_geometry`, `cad.dimensions` and `cad.no_interference` on it. A
`solidworks.rebuild` verifier fails the step when the rebuild reported
errors or warnings that the input did not allow. With the companion missing,
unpaired or SolidWorks not running, each verifier answers `{ ok: true,
unavailable: true, detail }` and each capability fails with
`tool_unavailable`, exactly as the CAD plug-in does without CadQuery.

## What it reads and writes

- **Reads** only files under the project's local folder, named by a path
  relative to it; the companion resolves the real path and refuses anything
  outside (`outside_project`), including through a junction or shortcut.
- **Writes** only into the run's sandbox copy, which the engine shares with
  the companion as a directory under the app data folder. A sandbox copy of
  an assembly carries its referenced parts, and the companion opens it with
  references resolved inside the copy (`SetSearchFolders` limited to the
  copy) so an edit can never reach the user's originals. Applying a result to
  the user's files is `apply_merge`, approved by the user, and is a file copy
  the engine does, not a SolidWorks operation.
- **Ingest** (`POST /api/plugins/solidworks/ingest`) walks the project
  folder, asks the companion to inspect each document, and writes `part` and
  `assembly` nodes with `contains` edges, external ids `<project>|<path>`,
  privacy `local` by default, the same as the CAD plug-in. The source
  `solidworks` is not in migration 039's list; building this adds it in a
  migration from the CAD range (070–079) that keeps every existing value.

## Failure modes

| Situation | What happens |
|---|---|
| Not Windows, or no companion installed | The plug-in registers, its status says `not_installed`; capabilities fail with `tool_unavailable`; verifiers are unavailable. Open formats keep working. |
| Companion running, SolidWorks not | The companion starts SolidWorks invisibly; if that fails (no licence, licence server down) the job fails `licence_unavailable`. |
| A document open and dirty in the user's SolidWorks | Read-only inspection uses a separate read-only open; an edit works on the sandbox copy only, so it never collides with the user's unsaved work. |
| A rebuild error after `set_dimensions` | The step fails with `rebuild_failed` and the feature that failed; the copy is discarded. |
| SolidWorks hangs or crashes mid-job | The job times out, the companion kills only an instance it started, and reports `timeout`; the run's step fails and records why. |
| The engine restarts mid-job | Jobs are idempotent per request id; the resumed step asks again and the companion answers from its finished-job cache or reruns on the copy. |
| A second engine or a web page tries the port | No pairing secret, no answer; the `Host` check and absent CORS stop browser access. |

## Security

- The companion is the user's own program on the user's own machine; it has
  the user's rights, so it accepts only the paired engine and only the
  declared capabilities, each with a strict input schema (paths, dimension
  names, numbers, export formats). No input is ever evaluated as code, a
  macro, or a command line.
- Model-written code never runs in SolidWorks. Everything an agent changes is
  data (dimension values, configuration names) applied to a copy.
- Paths are resolved and checked on the companion side as well as the engine
  side; the engine's check is not trusted alone.
- Nothing leaves the machine: no telemetry, no update check without the user
  asking, and graph nodes from SolidWorks files are `local` unless the user
  opts the project into the cloud.
- The companion is signed, and the engine records the companion's version
  and signature thumbprint at pairing and refuses a changed binary until the
  user pairs again.

## Not in scope

Drawings (`.slddrw`) beyond listing their sheets and referenced models; PDM
vaults; simulation; anything that needs SolidWorks on a machine other than
the user's.
