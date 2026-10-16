-- Approximate nearest-neighbour index for semantic search (cosine distance).
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_scope ON chunks (scope_id);
