import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { RAW_DIR } from '@/config';
import { db } from '@/db/client';
import { rawSnapshots } from '@/db/schema';
import { sha256 } from '@/lib/hash';
import { snapshotDate } from '@/lib/dates';
import { eq } from 'drizzle-orm';

export interface ArchiveInput {
  source: string;
  kind: string;
  key?: string;
  url?: string;
  body: string;
  httpStatus?: number;
}

export class RawStore {
  // Archive BEFORE validation — schema drift must never cost a day's snapshot.
  archive(input: ArchiveInput): number {
    const date = snapshotDate();
    const dir = path.join(RAW_DIR, input.source, date);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(11, 19).replaceAll(':', '');
    const name = [input.kind, input.key, stamp].filter(Boolean).join('-') + '.json.gz';
    const filePath = path.join(dir, name);
    const gz = gzipSync(Buffer.from(input.body));
    fs.writeFileSync(filePath, gz);
    const rows = db
      .insert(rawSnapshots)
      .values({
        source: input.source,
        kind: input.kind,
        key: input.key,
        url: input.url,
        capturedAt: Date.now(),
        filePath: path.relative(process.cwd(), filePath),
        sha256: sha256(input.body),
        bytes: gz.length,
        httpStatus: input.httpStatus,
        parseOk: null,
      })
      .returning({ id: rawSnapshots.id })
      .all();
    return rows[0]!.id;
  }

  setParseOk(id: number, ok: boolean): void {
    db.update(rawSnapshots).set({ parseOk: ok }).where(eq(rawSnapshots.id, id)).run();
  }
}
