import { mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceClient, ingest } from './source.js';
import { IdentityStore } from './identity.js';
import { Anonymizer } from './anonymize.js';
import { keptEntities } from './kept.js';
import { findLeaks, repairDigitLeaks } from './leak-audit.js';
import type { RecordCounts, RecordValue, SourceKind, Entity } from './types.js';

const files = { chats: 'chats.jsonl', docs: 'docs.jsonl', tables: 'tables.jsonl' } as const;
export const outputFiles = new Set([...Object.values(files), 'entities.json']);
function lines(records: RecordValue[]): string { return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''); }
function verifyIds(actual: string[], expected: string[], kind: string): void {
  const unique = new Set(actual); const source = new Set(expected);
  if (unique.size !== actual.length || unique.size !== source.size || [...source].some(id => !unique.has(id))) throw new Error(`${kind} record IDs do not match source index`);
}
function folded(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function appears(text: string, value: string): boolean {
  if (folded(text).includes(folded(value))) return true;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 6 && digits.length >= value.length * 0.6 && text.replace(/\D/g, '').includes(digits);
}
function visibleEntities(entities: Entity[], records: RecordValue[]): Entity[] {
  const byId = new Map(records.map(record => [record.id, JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'id')))]));
  return entities.map(entity => {
    if (entity.kept || !entity.pseudonyms) return entity;
    const text = entity.records.map(id => byId.get(id) ?? '').join('\n');
    const pseudonyms = Object.fromEntries(Object.entries(entity.pseudonyms).flatMap(([kind, value]) => {
      if (appears(text, value)) return [[kind, value]];
      if (kind === 'email') {
        const spoken = value.replace('@', ' arroba ').replace(/\./g, ' punto ');
        if (appears(text, spoken)) return [[kind, spoken]];
      }
      return [];
    }));
    return { ...entity, pseudonyms };
  }).filter(entity => entity.kept || Object.keys(entity.pseudonyms ?? {}).length > 0);
}
export async function runPipeline(sourcesUrl: string, token: string, outputDir: string, dbFile: string): Promise<RecordCounts> {
  const input = await ingest(new SourceClient(sourcesUrl, token));
  for (const kind of ['chats', 'docs', 'tables'] as const) verifyIds(input[kind].map(r => r.id), input.index[kind], kind);
  const store = new IdentityStore(dbFile);
  const engine = new Anonymizer(store);
  try {
    engine.registerCorpus(input);
    const process = () => ({
      chats: input.chats.map(r => engine.anonymize(r, input.uidByChat.get(r.id))),
      docs: input.docs.map(r => engine.anonymize(r)),
      tables: input.tables.map(r => engine.anonymize(r)),
    });
    let out = process();
    for (let attempt = 0; attempt < 2; attempt++) {
      const leaks = findLeaks([...out.chats, ...out.docs, ...out.tables], store);
      if (!leaks.length) break;
      if (attempt === 1) {
        const counts = new Map<string, number>();
        for (const leak of leaks) for (const field of leak.fields) {
          const key = `${leak.personId}/${leak.sources.join('+')}/${field}/${leak.kind}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const summary = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([field, count]) => `${field}:${count}`).join(', ');
        throw new Error(`Privacy audit found ${leaks.length} unresolved source forms (${summary})`);
      }
      engine.repair(leaks);
      out = process();
      repairDigitLeaks([...out.chats, ...out.docs, ...out.tables], leaks, store);
    }
    const temp = `${outputDir}.next`;
    await rm(temp, { recursive: true, force: true }); await mkdir(temp, { recursive: true });
    for (const kind of ['chats', 'docs', 'tables'] as const) await writeFile(join(temp, files[kind]), lines(out[kind]), 'utf8');
    const allRecords = [...out.chats, ...out.docs, ...out.tables];
    const outputIds = new Set(allRecords.map(record => record.id));
    await writeFile(join(temp, 'entities.json'), JSON.stringify({ entities: [...visibleEntities(store.entities(undefined, outputIds).filter(entity => entity.records.length), allRecords), ...keptEntities(allRecords)] }), 'utf8');
    const previous = `${outputDir}.previous`;
    await rm(previous, { recursive: true, force: true });
    let hadPrevious = false;
    try { await access(outputDir); hadPrevious = true; } catch { /* first run */ }
    if (hadPrevious) await rename(outputDir, previous);
    try { await rename(temp, outputDir); }
    catch (error) { if (hadPrevious) await rename(previous, outputDir); throw error; }
    await rm(previous, { recursive: true, force: true });
    return { chats: out.chats.length, docs: out.docs.length, tables: out.tables.length };
  } finally { store.close(); }
}

export function anonymizeLive(source: SourceKind, records: RecordValue[], dbFile: string): { records: RecordValue[]; entities: Entity[] } {
  const store = new IdentityStore(dbFile); const engine = new Anonymizer(store);
  try {
    engine.registerLive(records);
    let output = records.map(record => engine.anonymize(record));
    for (let attempt = 0; attempt < 2; attempt++) {
      const leaks = findLeaks(output, store);
      if (!leaks.length) break;
      if (attempt === 1) throw new Error(`Privacy audit found ${leaks.length} unresolved source forms`);
      engine.repair(leaks);
      output = records.map(record => engine.anonymize(record));
    }
    return { records: output, entities: [...engine.usedEntities(), ...keptEntities(output)] };
  } finally { store.close(); }
}
