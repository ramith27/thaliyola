-- When each repository's stack was last read from GitHub/GitLab, and why it couldn't be (private without a token, …).
ALTER TABLE components ADD COLUMN detected_at timestamptz, ADD COLUMN detect_error text;
