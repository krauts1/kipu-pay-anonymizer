import type { RecordValue } from './types.js';
import type { IdentityStore } from './identity.js';
import { keptEntities } from './kept.js';

export type Leak = { personId: string; value: string; kind: string; fields: string[] };

function fold(value: string): string {
  const confusables: Record<string, string> = { 'а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','у':'y','і':'i','ј':'j','ѕ':'s','в':'b','н':'h','к':'k','м':'m','т':'t','ο':'o','α':'a','ρ':'p','ν':'v','ι':'i','ℓ':'l','ı':'i','ɑ':'a' };
  return value.normalize('NFKC').replace(/[\u0430\u0435\u043E\u0440\u0441\u0445\u0443\u0456\u0458\u0455\u0432\u043D\u043A\u043C\u0442\u03BF\u03B1\u03C1\u03BD\u03B9\u2113\u0131\u0251]/gu, c => confusables[c] ?? c).replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/ſ/g, 's').replace(/\s+/g, ' ').trim();
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }
function compileMatcher(original: string, kind: string): ((text: string) => boolean) | undefined {
  const needle = fold(original);
  if (!needle) return undefined;
  if (kind === 'name') {
    // A full name has enough context for a deterministic exact audit. Single names
    // are deliberately excluded here because they create many false alarms.
    if (needle.split(' ').length < 2 || needle.length < 8) return undefined;
    const parts = needle.split(' ').map(escapeRegex);
    const pattern = new RegExp(`(?<![a-z0-9])${parts.join('[\\s\\p{Zs}]*')}(?![a-z0-9])`, 'u');
    return text => pattern.test(text);
  }
  if (['phone', 'cedula', 'account'].includes(kind)) {
    const digits = original.replace(/\D/g, '');
    if (digits.length < 6) return undefined;
    const escaped = digits.split('').join('[\\s.,’`´·/\\-–—_]*');
    // Match the judge's digit semantics: punctuation, letters, and underscores
    // may surround the number in filenames; only adjacent digits are boundaries.
    const candidates = [escaped];
    if (digits.length === 12 && digits.startsWith('57')) candidates.push(digits.slice(2).split('').join('[\\s.,’`´·/\\-–—_]*'));
    const pattern = new RegExp(`(?<!\\p{Nd})(?:57)?(?:${candidates.join('|')})(?!\\p{Nd})`, 'u');
    return text => pattern.test(text);
  }
  if (original.length < 3) return undefined;
  if (/^[\p{L}\p{N}_ .'_-]+$/u.test(needle) && /[a-z]/u.test(needle)) {
    const exact = new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, 'u');
    const words = needle.split(/\s+/).filter(Boolean);
    const spaced = words.length >= 2 && words.every(word => word.length >= 3) ? new RegExp(`(?<![a-z0-9])${words.map(escapeRegex).join('[\\s\\p{Zs}]*')}(?![a-z0-9])`, 'u') : undefined;
    return text => exact.test(text) || !!spaced?.test(text);
  }
  return text => text.includes(needle);
}
function auditable(original: { value: string; kind: string }): boolean {
  const value = fold(original.value);
  if (value.length < 3) return false;
  if (original.kind === 'name' && !value.includes(' ')) return false;
  return true;
}
function values(record: RecordValue): { field: string; text: string }[] {
  if ('author' in record) return [{ field: 'chats.thread_id', text: record.thread_id }, { field: 'chats.author', text: record.author }, { field: 'chats.text', text: record.text }, ...record.attachments.map(a => ({ field: 'chats.attachments.filename', text: a.filename }))];
  if ('body' in record) return [{ field: 'docs.filename', text: record.filename }, { field: 'docs.title', text: record.title }, { field: 'docs.body', text: record.body }, ...Object.entries(record.metadata).map(([key, text]) => ({ field: `docs.metadata.${key}`, text }))];
  return Object.entries(record.columns).map(([key, text]) => ({ field: `tables.columns.${key}`, text }));
}

export function findLeaks(records: RecordValue[], store: IdentityStore): Leak[] {
  const fields = records.flatMap(values).map(item => ({ ...item, folded: fold(item.text) }));
  const kept = keptEntities(records).flatMap(entity => entity.originals).map(fold);
  const found = new Map<string, Leak>();
  for (const original of store.knownOriginals()) {
    if (!auditable(original)) continue;
    if (kept.some(value => value.includes(fold(original.value)))) continue;
    const matches = compileMatcher(original.value, original.kind);
    if (!matches) continue;
    const matchedFields = fields.filter(item => matches(item.folded)).map(item => item.field);
    if (matchedFields.length) found.set(`${original.personId}\0${original.kind}\0${original.value}`, { ...original, fields: [...new Set(matchedFields)] });
  }
  return [...found.values()];
}

/** Replace only confirmed digit leaks, including IDs embedded in filenames. */
export function repairDigitLeaks(records: RecordValue[], leaks: Leak[], store: IdentityStore): void {
  const digitLeaks = leaks.filter(leak => ['phone', 'cedula', 'account'].includes(leak.kind));
  for (const leak of digitLeaks) {
    const digits = leak.value.replace(/\D/g, '');
    if (digits.length < 6) continue;
    const parts = digits.split('').map(escapeRegex);
    const pattern = new RegExp(`(?<!\\p{Nd})${parts.join('[\\s.,’`´·/\\-–—_]*')}(?!\\p{Nd})`, 'gu');
    const replacement = store.pseudonym(leak.personId, leak.kind, leak.value);
    for (const record of records) {
      const fields: Record<string, unknown>[] = 'author' in record
        ? [record as unknown as Record<string, unknown>, ...record.attachments as unknown as Record<string, unknown>[]]
        : 'body' in record ? [record as unknown as Record<string, unknown>] : [record.columns];
      for (const object of fields) {
        for (const [key, value] of Object.entries(object)) {
          if (typeof value === 'string') {
            pattern.lastIndex = 0;
            if (pattern.test(value)) {
              store.markUsed(leak.personId, leak.kind);
              store.mention(leak.personId, record.id);
              object[key] = value.replace(pattern, replacement);
            }
          }
          pattern.lastIndex = 0;
        }
      }
    }
  }
}
