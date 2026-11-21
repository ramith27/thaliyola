-- Decisions get revisited: a new decision article gets a revisit date (review_due) six months out unless one is set,
-- and the owner is told once when any article's review date passes (until now nothing did). Pairs of decisions that
-- look like they contradict each other are suggested for review; a reviewer can say they don't.

ALTER TABLE articles ADD COLUMN review_notified_at timestamptz;

CREATE FUNCTION decision_revisit_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'decision' AND NEW.review_due IS NULL THEN
    NEW.review_due := current_date + 180;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER articles_decision_revisit BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION decision_revisit_date();

-- Decisions already recorded: six months after their last change, but no sooner than a month from now (so the first
-- run doesn't announce every old decision at once).
UPDATE articles SET review_due = greatest(updated_at::date + 180, current_date + 30) WHERE type = 'decision' AND review_due IS NULL;

CREATE TABLE decision_conflict_dismissals (
  a            uuid NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  b            uuid NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  dismissed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
