ALTER TABLE spaces ADD COLUMN assistant_defaults TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(assistant_defaults) AND json_type(assistant_defaults) = 'object');
