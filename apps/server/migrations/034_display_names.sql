-- Display names people choose for themselves (Account page, set_my_name, the name typed when accepting an
-- invitation) are marked: the access tools don't take such a name as someone's identity (an email is needed), and a
-- name someone cleared isn't filled in again from their sign-in. Names set by people with Manage people, from the
-- sign-in or before this migration are unmarked.
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_self_set boolean NOT NULL DEFAULT false;

-- What a name looks like, to tell whether two names (or a name and the start of an email address) would be taken for
-- each other: compatibility forms folded (fullwidth letters, ligatures), lower case; accents and other combining
-- marks, variation selectors, joiners, spaces and . _ - dropped; and Cyrillic, Greek and other letters that look like
-- Latin ones (and 0, 1, I, l, |) mapped to one letter. The \xHHHH escapes are Postgres regular expression code points.
CREATE OR REPLACE FUNCTION name_key(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT AS $$
  SELECT translate(
           regexp_replace(normalize(lower(normalize(t, NFKC)), NFKD),
                          '[\x300-\x36f\x1ab0-\x1aff\x1dc0-\x1dff\x20d0-\x20ff\xfe00-\xfe0f\xfe20-\xfe2f\x200c\x200d\s._-]+', '', 'g'),
           '01авекмнорстухѕіјһԁӏԛԝѵүɡАВЕКМНОРСТУХЅІЈҺӀԚԜѴҮαβεηικνορτυχϲϳΑΒΕΖΗΙΚΜΝΟΡΤΥΧϹiıɩ|ɑ',
           'olabekmhopctyxsljhdlqwvygabekmhopctyxsljhlqwvyabenlkvoptuxcjabezhlkmnoptyxclllla')
$$;

CREATE INDEX IF NOT EXISTS users_name_key ON users (name_key(display_name)) WHERE display_name IS NOT NULL;
