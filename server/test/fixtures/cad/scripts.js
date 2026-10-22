// CadQuery scripts the CAD tests run. Their text is part of the key a
// recorded answer is stored under (replay.js), so changing one means
// recording again.

export const BRACKET_SCRIPT = [
  'spacing = 50',
  'plate = cq.Workplane("XY").box(80, 20, 5, centered=False)',
  'result = plate.faces(">Z").workplane(origin=(0, 0, 5)).pushPoints([(15, 10), (15 + spacing, 10)]).hole(5)',
  '',
].join('\n');
export const DRILL_SCRIPT = 'result = cq.importers.importStep(project_path("cube.step")).faces(">Z").workplane(origin=(5, 5, 10)).hole(4)\n';
export const FAILING_SCRIPT = 'raise ValueError("the fillet radius is larger than the edge")\n';
export const NO_RESULT_SCRIPT = 'part = cq.Workplane("XY").box(1, 1, 1)\n';
export const NETWORK_SCRIPT = 'import socket\nsocket.create_connection(("192.0.2.1", 80), timeout=2)\nresult = cq.Workplane("XY").box(1, 1, 1)\n';
