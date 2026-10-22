"""Writes the STEP solid fixtures with CadQuery.

Run from server/ with a Python that has CadQuery:
    python test/fixtures/cad/generate_step.py
"""
import os

import cadquery as cq

HERE = os.path.dirname(os.path.abspath(__file__))

cube = cq.Workplane("XY").box(10, 10, 10, centered=False)
cq.exporters.export(cube, os.path.join(HERE, "cube.step"))

# Two 10 mm boxes, the second offset by 5 mm on every axis, as two solids in
# one file: they overlap by a 5 mm cube (125 mm^3).
a = cq.Workplane("XY").box(10, 10, 10, centered=False).val()
b = cq.Workplane("XY").box(10, 10, 10, centered=False).translate((5, 5, 5)).val()
cq.exporters.export(cq.Workplane().add(cq.Compound.makeCompound([a, b])), os.path.join(HERE, "two-boxes.step"))

# The same two boxes placed apart: 20 mm on x.
c = cq.Workplane("XY").box(10, 10, 10, centered=False).translate((20, 0, 0)).val()
cq.exporters.export(cq.Workplane().add(cq.Compound.makeCompound([a, c])), os.path.join(HERE, "two-boxes-apart.step"))
