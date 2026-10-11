-- Recipients who gave a name on the share page. Their id is part of the share token they are given
-- (`<shareId>.<version>.<recipientId>.<mac>`), so a torrent app using that token's .torrent/magnet
-- shows up under the name. One row per (share, name); never IPs.
CREATE TABLE share_recipients (
  id          TEXT PRIMARY KEY,
  share_id    TEXT NOT NULL REFERENCES shares(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (share_id, name)
);
