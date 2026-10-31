import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Entity } from './types.js';
import type { IndirectPlan } from './indirect.js';
import { keyForm, kindFromName, nameContext, newName } from './name-catalog.js';

export { keyForm } from './name-catalog.js';
function seed(value: string): number { return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16); }
function aliasKey(kind: string, value: string): string {
  if (['phone', 'cedula', 'account'].includes(kind)) return value.replace(/\D/g, '');
  if (kind === 'plate' || kind === 'passport') return value.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  return keyForm(value);
}

function normForLeak(value: string): string {
  return value.normalize('NFKC').replace(/[\u0430\u0435\u043E\u0440\u0441\u0445\u0443\u0456\u0458\u0455\u0410\u0415\u041E\u0420\u0421\u0425\u0423\u0406\u0408\u0405\u03BF\u03B1\u03C1\u03BD\u03B9\u2113\u0131\u0251]/g, c => ({ 'а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','у':'y','і':'i','ј':'j','ѕ':'s','А':'A','Е':'E','О':'O','Р':'P','С':'C','Х':'X','У':'Y','І':'I','Ј':'J','Ѕ':'S','ο':'o','α':'a','ρ':'p','ν':'v','ι':'i','ℓ':'l','ı':'i','ɑ':'a' }[c] ?? c)).replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function containsOriginal(haystack: string, original: string): boolean {
  const needle = normForLeak(original); const text = normForLeak(haystack);
  if (!needle) return false;
  if (/^[\p{L}\p{N}_ .'\-]+$/u.test(needle) && /\p{L}/u.test(needle)) {
    const words = needle.split(/\s+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(?<![\\p{L}\\p{N}_])${words.join('[\\s\\p{Zs}]*')}(?![\\p{L}\\p{N}_])`, 'u').test(text);
  }
  const digits = original.replace(/\D/g, '');
  if (digits.length >= 6 && digits.length >= original.length * 0.6 && !/[a-z]/i.test(original)) {
    const compact = haystack.normalize('NFKC').replace(/(?<=\d)[\s.,'’`´·/\-–—_]+(?=\d)/g, '');
    return new RegExp(`(?<!\\d)(?:57)?${digits}(?!\\d)`).test(compact);
  }
  return text.includes(needle);
}

export type Person = { id: string; name: string; pseudonym: string; aliases: string[]; identifiers: { kind: string; value: string }[]; pseudonyms: Record<string, string> };

export class IdentityStore {
  private db: DatabaseSync;
  private reservedOriginals = new Set<string>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS persons (id TEXT PRIMARY KEY, name TEXT NOT NULL, pseudonym TEXT NOT NULL UNIQUE, gender TEXT NOT NULL); CREATE TABLE IF NOT EXISTS aliases (kind TEXT NOT NULL, value TEXT NOT NULL, raw_value TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY(kind,value), FOREIGN KEY(person_id) REFERENCES persons(id)); CREATE TABLE IF NOT EXISTS originals (person_id TEXT NOT NULL, value TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'name', PRIMARY KEY(person_id,value)); CREATE TABLE IF NOT EXISTS mentions (person_id TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(person_id,record_id)); CREATE TABLE IF NOT EXISTS substitutions (person_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(person_id,kind)); CREATE TABLE IF NOT EXISTS used_substitutions (person_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(person_id,kind)); CREATE TABLE IF NOT EXISTS indirect (person_id TEXT PRIMARY KEY, plan TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(originals)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'kind')) this.db.exec("ALTER TABLE originals ADD COLUMN kind TEXT NOT NULL DEFAULT 'name'");
    this.db.exec(`UPDATE originals SET kind=COALESCE((SELECT kind FROM aliases WHERE aliases.person_id=originals.person_id AND aliases.raw_value=originals.value LIMIT 1), kind)`);
    for (const row of this.db.prepare('SELECT value FROM originals').all() as { value: string }[]) this.reservedOriginals.add(row.value);
  }
  close(): void { this.db.close(); }
  byAlias(kind: string, value: string): Person | undefined {
    if (!value.trim()) return undefined;
    const row = this.db.prepare('SELECT person_id FROM aliases WHERE kind=? AND value=?').get(kind, aliasKey(kind, value)) as { person_id: string } | undefined;
    return row ? this.byId(row.person_id) : undefined;
  }
  byId(id: string): Person | undefined {
    const row = this.db.prepare('SELECT id,name,pseudonym FROM persons WHERE id=?').get(id) as { id: string; name: string; pseudonym: string } | undefined;
    if (!row) return undefined;
    const aliases = (this.db.prepare('SELECT value FROM originals WHERE person_id=?').all(id) as { value: string }[]).map(r => r.value);
    const identifiers = this.db.prepare('SELECT kind,raw_value AS value FROM aliases WHERE person_id=?').all(id) as { kind: string; value: string }[];
    const pseudos = this.db.prepare('SELECT kind,value FROM substitutions WHERE person_id=?').all(id) as { kind: string; value: string }[];
    return { ...row, aliases, identifiers, pseudonyms: Object.fromEntries(pseudos.map(p => [p.kind, p.value])) };
  }
  create(aliasKind: string, aliasValue: string, name: string, country?: string): Person {
    const known = this.byAlias(aliasKind, aliasValue); if (known) return known;
    const gender = kindFromName(name);
    const context = nameContext(name, country);
    const sequence = (this.db.prepare('SELECT COALESCE(MAX(CAST(SUBSTR(id, 3) AS INTEGER)), 0) AS n FROM persons').get() as { n: number }).n;
    let attempt = 0;
    let pseudonym = newName(`${aliasKind}:${keyForm(aliasValue)}`, gender, context, attempt);
    while (this.db.prepare('SELECT 1 FROM persons WHERE pseudonym=?').get(pseudonym) || this.originalConflicts(pseudonym) || keyForm(pseudonym) === keyForm(name)) {
      if (++attempt > 1000) throw new Error('Unable to generate a collision-free name pseudonym');
      pseudonym = newName(`${aliasKind}:${keyForm(aliasValue)}`, gender, context, attempt);
    }
    const id = `p_${String(sequence + 1).padStart(5, '0')}`;
    this.db.prepare('INSERT INTO persons(id,name,pseudonym,gender) VALUES(?,?,?,?)').run(id, name, pseudonym, gender);
    this.addAlias(id, aliasKind, aliasValue);
    this.addOriginal(id, name, 'name');
    return this.byId(id)!;
  }
  addAlias(id: string, kind: string, value: string): void {
    if (!value.trim()) return;
    const normalized = aliasKey(kind, value);
    const existing = this.byAlias(kind, value);
    if (existing && existing.id !== id) return;
    this.db.prepare('INSERT OR IGNORE INTO aliases(kind,value,raw_value,person_id) VALUES(?,?,?,?)').run(kind, normalized, value, id);
    if (!['uid', 'cliente_id', 'employee_id', 'tx_id', 'radicado', 'live_name'].includes(kind)) this.addOriginal(id, value, kind);
  }
  moveAlias(kind: string, value: string, personId: string): void {
    const previous = this.byAlias(kind, value);
    if (!previous || previous.id === personId) return;
    this.db.prepare('UPDATE aliases SET person_id=? WHERE kind=? AND value=?').run(personId, kind, aliasKey(kind, value));
    const remaining = this.db.prepare('SELECT 1 FROM aliases WHERE person_id=? LIMIT 1').get(previous.id);
    const mentions = this.db.prepare('SELECT 1 FROM mentions WHERE person_id=? LIMIT 1').get(previous.id);
    if (!remaining && !mentions) {
      this.db.prepare('DELETE FROM originals WHERE person_id=?').run(previous.id);
      this.db.prepare('DELETE FROM substitutions WHERE person_id=?').run(previous.id);
      this.db.prepare('DELETE FROM used_substitutions WHERE person_id=?').run(previous.id);
      this.db.prepare('DELETE FROM persons WHERE id=?').run(previous.id);
    }
  }
  addOriginal(id: string, value: string, kind = 'name'): void { if (value.trim()) { this.db.prepare("INSERT INTO originals(person_id,value,kind) VALUES(?,?,?) ON CONFLICT(person_id,value) DO UPDATE SET kind=CASE WHEN originals.kind='name' AND excluded.kind<>'name' THEN excluded.kind ELSE originals.kind END").run(id, value, kind); this.reservedOriginals.add(value); } }
  knownOriginals(): { personId: string; value: string; kind: string }[] {
    return this.db.prepare('SELECT person_id AS personId,value,kind FROM originals').all() as { personId: string; value: string; kind: string }[];
  }
  private originalConflicts(candidate: string): boolean {
    for (const original of this.reservedOriginals) if (containsOriginal(candidate, original)) return true;
    return false;
  }
  reserveOriginals(values: string[]): void { for (const value of values) if (value.trim()) this.reservedOriginals.add(value); }
  private substitutionConflict(personId: string, kind: string, candidate: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM substitutions WHERE person_id<>? AND kind=? AND value=? LIMIT 1').get(personId, kind, candidate);
  }
  private candidate(kind: string, person: Person, original: string, attempt: number): string {
    const n = seed(attempt === 0 ? `${person.id}:${kind}` : `${person.id}:${kind}:${attempt}`);
    switch (kind) {
      case 'email': {
        const domain = original.split('@')[1]?.toLowerCase();
        const publicDomains = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'kipupay.co']);
        // A neutral local part avoids leaking either the real or pseudonym name
        // through substring-based leak checks. It remains stable per identity.
        return `contacto${n}${attempt ? attempt : ''}@${domain && publicDomains.has(domain) ? domain : 'correo.example'}`;
      }
      case 'phone': return `3${String(n % 1000000000).padStart(9, '0')}`;
      case 'cedula': return String(10000000 + (n % 90000000));
      case 'handle': return `@usuario_${n}`;
      case 'birth_iso': {
        const year = Number(original.slice(0, 4));
        const decade = year >= 1900 && year <= 2020 ? Math.floor(year / 10) * 10 : 1980;
        const replacementYear = decade + ((n % 9) + 1 + (year - decade)) % 10;
        return `${replacementYear}-${String(1 + n % 12).padStart(2, '0')}-${String(1 + n % 28).padStart(2, '0')}`;
      }
      case 'plate': return `${String.fromCharCode(65 + n % 26, 65 + Math.floor(n / 26) % 26, 65 + Math.floor(n / 676) % 26)}${String(n % 1000).padStart(3, '0')}`;
      case 'passport': return [...original].map((character, i) => /[A-Za-z]/.test(character) ? String.fromCharCode(65 + seed(`${person.id}:passport:${i}:${attempt}`) % 26) : /\d/.test(character) ? String(seed(`${person.id}:passport:${i}:${attempt}`) % 10) : character).join('');
      case 'account': return String(n % 10000000000).padStart(Math.max(8, original.length), '0');
      case 'address': {
        const streetType = original.match(/^(Calle|Carrera|Avenida|Av\.|Street|St\.|Road|Rd\.)\b/i)?.[1] ?? 'Calle';
        return `${streetType} ${1 + n % 99} # ${1 + Math.floor(n / 100) % 99}-${1 + Math.floor(n / 10000) % 99}`;
      }
      default: return person.pseudonym;
    }
  }
  setIndirect(id: string, plan: IndirectPlan): void { this.db.prepare('INSERT INTO indirect(person_id,plan) VALUES(?,?) ON CONFLICT(person_id) DO UPDATE SET plan=excluded.plan').run(id, JSON.stringify(plan)); }
  indirectPlans(): Map<string, IndirectPlan> { return new Map((this.db.prepare('SELECT person_id,plan FROM indirect').all() as { person_id: string; plan: string }[]).map(row => [row.person_id, JSON.parse(row.plan) as IndirectPlan])); }
  mention(id: string, recordId: string): void { this.db.prepare('INSERT OR IGNORE INTO mentions(person_id,record_id) VALUES(?,?)').run(id, recordId); }
  markUsed(id: string, kind: string): void { this.db.prepare('INSERT OR IGNORE INTO used_substitutions(person_id,kind) VALUES(?,?)').run(id, kind); }
  pseudonym(id: string, kind: string, original: string): string {
    const row = this.db.prepare('SELECT value FROM substitutions WHERE person_id=? AND kind=?').get(id, kind) as { value: string } | undefined;
    if (row) return row.value;
    const person = this.byId(id)!;
    let attempt = 0; let value = this.candidate(kind, person, original, attempt);
    while (this.originalConflicts(value) || this.substitutionConflict(id, kind, value)) {
      if (++attempt > 1000) throw new Error(`Unable to generate a collision-free pseudonym for kind: ${kind}`);
      value = this.candidate(kind, person, original, attempt);
    }
    this.db.prepare('INSERT INTO substitutions(person_id,kind,value) VALUES(?,?,?)').run(id, kind, value);
    return value;
  }
  people(): Person[] {
    const rows = this.db.prepare('SELECT id FROM persons').all() as { id: string }[];
    return rows.map(row => this.byId(row.id)!);
  }
  entities(ids?: Set<string>, allowedRecords?: Set<string>): Entity[] {
    return this.people().filter(p => !ids || ids.has(p.id)).map(p => {
      const used = new Set((this.db.prepare('SELECT kind FROM used_substitutions WHERE person_id=?').all(p.id) as { kind: string }[]).map(row => row.kind));
      const pseudonyms: Record<string, string> = {};
      if (used.has('name')) pseudonyms.name = p.pseudonym;
      for (const [kind, value] of Object.entries(p.pseudonyms)) if (used.has(kind)) pseudonyms[kind] = value;
      return { entity_id: p.id, type: 'person', originals: p.aliases, pseudonyms, records: (this.db.prepare('SELECT record_id FROM mentions WHERE person_id=?').all(p.id) as { record_id: string }[]).map(r => r.record_id).filter(id => !allowedRecords || allowedRecords.has(id)) };
    });
  }
}
