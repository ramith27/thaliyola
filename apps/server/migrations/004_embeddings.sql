-- Which model produced each embedding; chunks embedded by another model are re-embedded.
ALTER TABLE chunks ADD COLUMN embedding_model text;
CREATE INDEX chunks_unembedded ON chunks (id) WHERE embedding IS NULL;
