# KiCad test fixtures

Written for Scope Studio's KiCad plug-in tests and released under CC0 1.0
(public domain dedication). Nothing here is copied from KiCad's libraries or
from any other project; the library symbols embedded in the schematics are
simplified drawings that only borrow KiCad's well-known library names
(`Device:R`, `power:GND`, …) so the files read like ordinary KiCad projects.

- `ldo-led/` — a KiCad 8 project: a 2-pin input connector feeding an
  AMS1117-3.3 LDO regulator with 10 µF input and 22 µF output capacitors, and
  a red LED with a 330 Ω series resistor on the 3.3 V rail.
  `ldo-led.kicad_sch` is the schematic, `ldo-led.kicad_pcb` the board (parts
  placed and every pad on its net, not routed), `ldo-led.kicad_pro` the
  project file.
- `ldo-led-faulty/` — the same schematic with deliberate faults for the
  review: the output capacitor removed (the 3.3 V rail has no decoupling),
  R1's value cleared, D1's footprint cleared, D1's cathode left unconnected,
  and a test point with a no-connect flag (which must not be reported).
- `reports/` — ERC and DRC reports in the JSON format kicad-cli 8 writes
  (`schemas.kicad.org/erc.v1.json` and `drc.v1.json`). They were written by
  hand for these fixtures, not captured from kicad-cli: kicad-cli 8 was not
  installable where the plug-in was built (Ubuntu 24.04 ships KiCad 7, whose
  kicad-cli has no `erc`/`drc` commands). Tests use them to exercise the
  verifiers when kicad-cli is absent; where kicad-cli 8+ is installed the
  tests also run the real tool on the fixtures.
