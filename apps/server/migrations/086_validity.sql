-- Facts with dates: when an article or finding became true (valid_from) and stopped being true (valid_until).
-- Search hides what has expired and, with as_of, answers "how did this work on <date>?" from the items valid then,
-- superseded ones included. Superseding an item closes its dates on its own.
ALTER TABLE articles ADD COLUMN valid_from date, ADD COLUMN valid_until date,
  ADD CONSTRAINT articles_valid_range CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from);
ALTER TABLE findings ADD COLUMN valid_from date, ADD COLUMN valid_until date,
  ADD CONSTRAINT findings_valid_range CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from);

-- What was superseded already stopped being true when it was last changed.
UPDATE articles SET valid_until = greatest(updated_at::date, created_at::date + 1) WHERE status = 'superseded' AND valid_until IS NULL;
UPDATE findings SET valid_until = greatest(updated_at::date, created_at::date + 1) WHERE status = 'superseded' AND valid_until IS NULL;

-- "A supersedes B": B stops being true today (unless it already had an end), A starts today (unless it had a start).
CREATE FUNCTION close_superseded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'supersedes' THEN RETURN NEW; END IF;
  IF NEW.to_kind = 'article' THEN
    UPDATE articles SET valid_until = greatest(current_date, coalesce(valid_from, created_at::date) + 1) WHERE id = NEW.to_id AND valid_until IS NULL;
  ELSIF NEW.to_kind = 'finding' THEN
    UPDATE findings SET valid_until = greatest(current_date, coalesce(valid_from, created_at::date) + 1) WHERE id = NEW.to_id AND valid_until IS NULL;
  END IF;
  IF NEW.from_kind = 'article' THEN
    UPDATE articles SET valid_from = current_date WHERE id = NEW.from_id AND valid_from IS NULL AND (valid_until IS NULL OR valid_until > current_date);
  ELSIF NEW.from_kind = 'finding' THEN
    UPDATE findings SET valid_from = current_date WHERE id = NEW.from_id AND valid_from IS NULL AND (valid_until IS NULL OR valid_until > current_date);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER relations_close_superseded AFTER INSERT ON relations FOR EACH ROW EXECUTE FUNCTION close_superseded();

-- Marked superseded without a relation: it ends today.
CREATE FUNCTION end_when_superseded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'superseded' AND OLD.status IS DISTINCT FROM 'superseded' AND NEW.valid_until IS NULL THEN
    NEW.valid_until := greatest(current_date, coalesce(NEW.valid_from, NEW.created_at::date) + 1);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER articles_end_when_superseded BEFORE UPDATE OF status ON articles FOR EACH ROW EXECUTE FUNCTION end_when_superseded();
CREATE TRIGGER findings_end_when_superseded BEFORE UPDATE OF status ON findings FOR EACH ROW EXECUTE FUNCTION end_when_superseded();
