/**
 * Regenerates prisma/schema.sqlite.prisma from prisma/schema.prisma.
 *
 * Prisma will not take a datasource provider from an environment variable, so
 * exercising the repository against a real database in tests needs a second
 * schema file. Keeping it hand-written would guarantee drift; generating it
 * means the Postgres schema stays the single source of truth.
 *
 * Only storage details are translated: SQLite has no native Decimal/Date type
 * hints and no Json column. Models, fields and relations are untouched, and
 * tests/prisma.test.ts asserts that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma');
const src = fs.readFileSync(path.join(dir, 'schema.prisma'), 'utf8');

const out = src
  .replace('provider = "postgresql"', 'provider = "sqlite"')
  .replace('url      = env("DATABASE_URL")', 'url      = env("SQLITE_URL")')
  .replace(
    'generator client {\n  provider = "prisma-client-js"\n}',
    'generator client {\n  provider = "prisma-client-js"\n  output   = "../node_modules/.prisma/test-client"\n}',
  )
  .replace(/\s+@db\.[A-Za-z]+(\([^)]*\))?/g, '')
  .replace(/(\s)Json(\s|\?)/g, '$1String$2');

const header = `// GENERATED FROM schema.prisma BY scripts/mirror-schema.mjs — DO NOT EDIT.
//
// SQLite mirror, for local tests only. Prisma cannot take its datasource
// provider from an environment variable, so verifying the repository without
// standing up Postgres needs a second schema. Native type hints and Json are
// translated because SQLite has neither; the MODELS must not drift, and
// tests/prisma.test.ts fails if they do.
//
//   npm run db:mirror && npm run db:push:test
`;

fs.writeFileSync(path.join(dir, 'schema.sqlite.prisma'), header + out);
console.log('wrote prisma/schema.sqlite.prisma');
