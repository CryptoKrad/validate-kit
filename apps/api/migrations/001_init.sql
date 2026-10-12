-- BUILD: initial schema + idempotent seed.
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL
);

-- Seed two users. password_hash values are REAL scrypt hashes of the plaintext
-- "password" in "<saltHex>:<keyHex>" form (16-byte salt, 64-byte key) and are
-- verifiable by verifyPassword() in src/routes/login.ts. ON CONFLICT keeps this
-- idempotent so the migration is safe to re-run / load into a fresh testcontainer.
INSERT INTO users (email, password_hash) VALUES
  (
    'alice@example.com',
    'b9f511f09f8b047ae7c6ec734a34926c:a6b22c779dfbb43b1381e9c7240aa0cfca5b0d990b3fea53ed9ab23624b7102ee433d2299ec9facd00917d8ffc751322ecf654582fde03168ab4abb97669ca23'
  ),
  (
    'bob@example.com',
    '703b3ad29c3ca5b7154a955b247e8c8f:0f9643bed013ee2b386458ef4340a439e9e06e15d228117c9678239d1ca7c1a8a88dc3ae28fb54ee274376157514ce4a75c06c92f44aefeaf93306d58635daab'
  )
ON CONFLICT (email) DO NOTHING;
