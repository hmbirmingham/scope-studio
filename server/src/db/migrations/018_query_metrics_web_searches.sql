-- How many web searches an answer ran. Searches are billed per search on top
-- of tokens, and one that informed nothing left no trace before this column.
ALTER TABLE query_metrics ADD COLUMN web_searches INTEGER;
