"""The CadQuery side of the CAD plug-in.

The engine copies this file, the request and the input files into a private
scratch directory and runs it there with the OS sandbox (no network, nothing
writable but that directory). It answers on stdout with one line that starts
with the marker below, followed by JSON. Everything else it prints (warnings
from the libraries it imports) is ignored.

Modes:
  probe         report the CadQuery version.
  inspect       geometry of each input (a STEP file): validity, solids,
                volume, area, centre of mass, inertia, bounding box, and a
                tessellated STL for the engine to measure sections on.
  interference  pairwise common volume between every solid of every input.
  edit          run a model-written CadQuery script that sets `result`,
                export it (STEP or STL by the output's extension) and
                inspect it.

OCCT works in millimetres: a STEP file in another unit is converted on import,
so every length here is in mm.
"""

import json
import sys
import traceback

MARKER = "@@SCOPE_CAD@@"


def answer(payload, code=0):
    sys.stdout.write("\n" + MARKER + json.dumps(payload) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(code, message, **extra):
    payload = {"error": {"code": code, "message": message[-2000:]}}
    payload["error"].update(extra)
    answer(payload, 1)


def load_request():
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        return json.load(handle)


def import_cadquery():
    try:
        import cadquery  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on the machine
        fail("cadquery_missing", "CadQuery could not be imported: %s" % exc)
    import cadquery as cq

    return cq


def as_shape(cq, value):
    """A Workplane, Shape or Assembly as one OCCT shape."""
    if isinstance(value, cq.Workplane):
        objects = [v for v in value.vals() if isinstance(v, cq.Shape)]
        if not objects:
            raise ValueError("the Workplane holds no shapes")
        return objects[0] if len(objects) == 1 else cq.Compound.makeCompound(objects)
    if isinstance(value, cq.Assembly):
        return value.toCompound()
    if isinstance(value, cq.Shape):
        return value
    raise TypeError("result must be a cadquery Workplane, Shape or Assembly, not %s" % type(value).__name__)


def inertia_of(shape):
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape.wrapped, props)
    matrix = props.MatrixOfInertia()
    return [[matrix.Value(i, j) for j in (1, 2, 3)] for i in (1, 2, 3)]


def describe(cq, shape, mesh_path=None):
    solids = shape.Solids()
    box = shape.BoundingBox()
    volume = sum(solid.Volume() for solid in solids) if solids else 0.0
    info = {
        "unit": "mm",
        "valid": bool(shape.isValid()),
        "solids": len(solids),
        "faces": len(shape.Faces()),
        "volume": volume,
        "surfaceArea": shape.Area(),
        "solidVolumes": [solid.Volume() for solid in solids],
        "boundingBox": {
            "min": [box.xmin, box.ymin, box.zmin],
            "max": [box.xmax, box.ymax, box.zmax],
            "size": [box.xlen, box.ylen, box.zlen],
        },
        "centroid": None,
        "inertia": None,
    }
    if solids and volume > 0:
        centre = cq.Shape.centerOfMass(shape)
        info["centroid"] = [centre.x, centre.y, centre.z]
        info["inertia"] = inertia_of(shape)
    if mesh_path:
        cq.exporters.export(cq.Workplane().add(shape), mesh_path, exportType="STL", tolerance=0.01, angularTolerance=0.1)
        info["mesh"] = mesh_path
    return info


def import_any(cq, path):
    lower = path.lower()
    if lower.endswith(".step") or lower.endswith(".stp"):
        return as_shape(cq, cq.importers.importStep(path))
    raise ValueError("CadQuery reads STEP here; %s is not a STEP file" % path)


def mode_inspect(cq, request):
    out = []
    for index, item in enumerate(request["inputs"]):
        shape = import_any(cq, item["path"])
        mesh = "out/mesh-%d.stl" % index if request.get("mesh") else None
        info = describe(cq, shape, mesh)
        info["name"] = item["name"]
        out.append(info)
    return {"files": out}


def mode_interference(cq, request):
    solids = []
    for item in request["inputs"]:
        shape = import_any(cq, item["path"])
        for index, solid in enumerate(shape.Solids()):
            solids.append(("%s#%d" % (item["name"], index + 1), item["name"], solid))
    tolerance = float(request.get("tolerance", 1e-6))
    pairs = []
    for i in range(len(solids)):
        for j in range(i + 1, len(solids)):
            label_a, file_a, a = solids[i]
            label_b, file_b, b = solids[j]
            # Solids of one input file are only compared when the request
            # asks for that (a single assembly file).
            if file_a == file_b and not request.get("withinFiles"):
                continue
            box_a, box_b = a.BoundingBox(), b.BoundingBox()
            overlap = (
                box_a.xmin <= box_b.xmax and box_b.xmin <= box_a.xmax
                and box_a.ymin <= box_b.ymax and box_b.ymin <= box_a.ymax
                and box_a.zmin <= box_b.zmax and box_b.zmin <= box_a.zmax
            )
            volume = 0.0
            if overlap:
                common = a.intersect(b)
                volume = sum(s.Volume() for s in common.Solids()) if common.Solids() else 0.0
            pairs.append({"a": label_a, "b": label_b, "interferes": volume > tolerance, "volume": volume})
    return {"solids": len(solids), "pairs": pairs, "unit": "mm"}


def mode_edit(cq, request):
    inputs = {item["name"]: item["path"] for item in request.get("inputs", [])}

    def project_path(name):
        if name not in inputs:
            raise KeyError("%s was not declared as an input of this edit" % name)
        return inputs[name]

    with open(request["script"], "r", encoding="utf-8") as handle:
        source = handle.read()
    scope = {"cq": cq, "cadquery": cq, "project_path": project_path, "__name__": "__scope_cad__"}
    try:
        exec(compile(source, "edit.py", "exec"), scope)
    except Exception:
        fail("script_error", traceback.format_exc())
    if "result" not in scope:
        fail("no_result", "the script must assign the part to a variable named result")
    try:
        shape = as_shape(cq, scope["result"])
    except Exception as exc:
        fail("no_result", str(exc))
    output = request["output"]
    lower = output.lower()
    if lower.endswith(".stl"):
        cq.exporters.export(cq.Workplane().add(shape), output, exportType="STL", tolerance=0.01, angularTolerance=0.1)
    else:
        cq.exporters.export(cq.Workplane().add(shape), output, exportType="STEP")
    info = describe(cq, shape, "out/mesh-result.stl")
    info["output"] = output
    return info


def main():
    request = load_request()
    mode = request.get("mode")
    if mode == "probe":
        cq = import_cadquery()
        answer({"version": getattr(cq, "__version__", "unknown")})
    cq = import_cadquery()
    try:
        if mode == "inspect":
            answer(mode_inspect(cq, request))
        if mode == "interference":
            answer(mode_interference(cq, request))
        if mode == "edit":
            answer(mode_edit(cq, request))
    except SystemExit:
        raise
    except Exception:
        fail("cadquery_error", traceback.format_exc())
    fail("invalid_request", "unknown mode %r" % mode)


if __name__ == "__main__":
    main()
