-- items.name is UNIQUE across all rows, so a deleted item used to block its name forever (and
-- ingest/admin disagreed about whether it was taken). Deleted rows now keep a tombstone name
-- `<name> [deleted <id>]` (set by ingest on delete); convert rows deleted before this change.
UPDATE items
   SET name = name || ' [deleted ' || id || ']'
 WHERE status = 'deleted'
   AND name NOT LIKE '% [deleted ' || id || ']';
