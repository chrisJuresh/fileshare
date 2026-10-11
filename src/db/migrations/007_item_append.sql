-- "Add files" to a ready folder item (docs/ARCHITECTURE.md §4 append): the upload batch whose files
-- are being appended. Set while the item goes hashing → snapshotting → ready again; cleared at ready.
ALTER TABLE items ADD COLUMN append_batch_id TEXT;
