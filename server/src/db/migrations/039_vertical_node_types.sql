-- The node vocabulary of the four Wave 4 verticals (KiCad, research, physics,
-- CAD), added in one migration so the plug-ins never redefine these
-- constraints one after another; the last to run would otherwise drop the
-- others' types. Only additions: everything valid before is still valid.
ALTER TABLE nodes DROP CONSTRAINT nodes_type_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_type_check CHECK (type IN (
  'repo', 'file', 'decision', 'spec', 'paper', 'datasheet', 'conversation',
  'plan', 'step', 'finding', 'artifact', 'question',
  -- KiCad
  'schematic', 'board', 'symbol', 'net', 'footprint', 'bom_row',
  -- Research
  'note', 'excerpt',
  -- Physics
  'derivation', 'computation',
  -- CAD
  'part', 'assembly'
));

ALTER TABLE nodes DROP CONSTRAINT nodes_source_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_source_check CHECK (source IN (
  'github', 'notion', 'kicad', 'overleaf', 'zotero', 'manual', 'agent',
  'pdf', 'physics', 'cad'
));

ALTER TABLE node_relationships DROP CONSTRAINT node_relationships_type_check;
ALTER TABLE node_relationships ADD CONSTRAINT node_relationships_type_check CHECK (type IN (
  'depends_on', 'references', 'supersedes', 'caused_by', 'part_of',
  'derived_from', 'produces', 'follows', 'answers',
  -- A net connects symbol pins; a footprint implements a symbol; a paper or
  -- note cites another; an assembly contains a part.
  'connects', 'implements', 'cites', 'contains'
));
