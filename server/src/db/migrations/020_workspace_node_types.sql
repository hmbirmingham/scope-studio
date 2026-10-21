-- Runs write their working memory into the graph (docs/architecture/agent-workspace.md),
-- so the node and relationship vocabularies grow. Only additions: every value
-- that was valid before is still valid, so existing rows and older engines are
-- unaffected.
ALTER TABLE nodes DROP CONSTRAINT nodes_type_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_type_check CHECK (type IN (
  'repo', 'file', 'decision', 'spec', 'paper', 'datasheet', 'conversation',
  'plan', 'step', 'finding', 'artifact', 'question'
));

ALTER TABLE nodes DROP CONSTRAINT nodes_source_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_source_check CHECK (source IN (
  'github', 'notion', 'kicad', 'overleaf', 'zotero', 'manual', 'agent'
));

ALTER TABLE node_relationships DROP CONSTRAINT node_relationships_type_check;
ALTER TABLE node_relationships ADD CONSTRAINT node_relationships_type_check CHECK (type IN (
  'depends_on', 'references', 'supersedes', 'caused_by', 'part_of',
  'derived_from', 'produces', 'follows', 'answers'
));
