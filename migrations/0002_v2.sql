-- v2: appraiser credentials on the user record; per-appraiser assignment index
ALTER TABLE users ADD COLUMN license_no TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN license_state TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN license_expires TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN eo_expires TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN eo_carrier TEXT DEFAULT '';
ALTER TABLE orders ADD COLUMN assigned_to TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS orders_assigned ON orders(assigned_to);
