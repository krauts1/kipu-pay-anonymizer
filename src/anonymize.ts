import type { RecordValue } from './types.js';
import type { Ingested } from './source.js';
import { IdentityStore, keyForm, type Person } from './identity.js';
import { aliasFragment, canonicalSpokenEmail, detectExplicit, type DetectedSpan } from './pii-patterns.js';
import { planIndirect, type IndirectPlan } from './indirect.js';
import { isKeptName } from './kept.js';

type Alias = { person: Person; kind: string; original: string };
type Edit = { start: number; end: number; text: string; person: Person; original: string; priority: number; kind?: string; quasi?: boolean };
const digitAliases = new Set(['cedula', 'phone', 'account']);
const privateFields: Record<string, string> = { nombre_completo: 'name', nombre: 'name', agente: 'name', reporta_a: 'name', author: 'name', correo: 'email', email: 'email', celular: 'phone', telefono: 'phone', num_doc: 'cedula', cedula: 'cedula', documento: 'cedula', direccion: 'address', fecha_nacimiento: 'birth_iso', placa: 'plate', pasaporte: 'passport', cuenta: 'account' };
const stableFields = new Set(['cliente_id', 'tx_id', 'radicado', 'id']);

function caseLike(original: string, replacement: string): string { return original === original.toUpperCase() && /[A-Z]/.test(original) ? replacement.toUpperCase() : replacement; }
function formatLike(original: string, replacement: string, kind: string): string {
  if (kind === 'name') return caseLike(original, replacement);
  if (kind === 'plate') return caseLike(original, /[- ]/.test(original) ? replacement.replace(/(?<=^[A-Za-z]{3})/, original.includes('-') ? '-' : ' ') : replacement);
  if (kind === 'email' && /\s+arroba\s+/i.test(original)) return replacement.replace('@', ' arroba ').replace(/\./g, ' punto ');
  if (['cedula', 'phone', 'account'].includes(kind)) {
    const digits = replacement.replace(/\D/g, '');
    if (original.replace(/\D/g, '').length === digits.length && /\D/.test(original)) { let offset = 0; return original.replace(/\d/g, () => digits[offset++]); }
  }
  return replacement;
}
function isFullName(value: string): boolean { return value.trim().split(/\s+/).length >= 2 && /\p{L}/u.test(value); }
function aliasPattern(kind: string, original: string): string {
  if (!digitAliases.has(kind)) return aliasFragment(original);
  return [...original.replace(/\D/g, '')].map(d => d).join('[\\s.,’`´·/\\-–—_]*');
}

export class Anonymizer {
  private names = new Map<string, Person[]>();
  private aliases = new Map<string, Alias[]>();
  private contextAliases = new Map<string, Person[]>();
  private contextMatcher?: RegExp;
  private threadContexts = new Map<string, Person>();
  private matcher?: RegExp;
  private indirect: Map<string, IndirectPlan>;
  private touched = new Set<string>();
  constructor(private readonly store: IdentityStore) { this.indirect = store.indirectPlans(); this.rebuild(); }
  usedEntities() { return this.store.entities(this.touched); }
  prepare(): void { this.rebuild(); }
  repair(leaks: { personId: string; value: string; kind: string }[]): void {
    for (const leak of leaks) this.store.addAlias(leak.personId, leak.kind, leak.value);
    this.rebuild();
  }
  private buildThreadContexts(chats: Ingested['chats'], uidByChat: Map<string, string>): void {
    this.threadContexts.clear();
    const groups = new Map<string, Map<string, Person>>();
    for (const chat of chats) {
      const group = groups.get(chat.thread_id) ?? new Map<string, Person>();
      const uid = uidByChat.get(chat.id); const author = uid ? this.store.byAlias('uid', uid) : undefined;
      if (author && author.identifiers.some(alias => alias.kind === 'cliente_id')) group.set(author.id, author);
      for (const person of this.contextPeople(`${chat.text} ${chat.attachments.map(a => a.filename).join(' ')}`)) if (person.identifiers.some(alias => alias.kind === 'cliente_id')) group.set(person.id, person);
      groups.set(chat.thread_id, group);
    }
    for (const [threadId, people] of groups) if (people.size === 1) this.threadContexts.set(threadId, [...people.values()][0]);
  }
  private mark(person: Person, recordId: string, kind?: string): void { this.touched.add(person.id); this.store.mention(person.id, recordId); if (kind) this.store.markUsed(person.id, kind); }

  private rebuild(): void {
    this.names.clear(); this.aliases.clear(); this.contextAliases.clear();
    const people = this.store.people();
    for (const person of people) {
      if (isFullName(person.name)) {
        const key = keyForm(person.name);
        this.names.set(key, [...(this.names.get(key) ?? []), person]);
        this.addAlias(person, 'name', person.name);
        const first = person.name.split(/\s+/)[0];
        if (first.length >= 4) this.addAlias(person, 'first_name', first);
      }
      for (const alias of person.identifiers) {
        if (['tx_id', 'radicado'].includes(alias.kind)) {
          const key = keyForm(alias.value); const list = this.contextAliases.get(key) ?? [];
          if (!list.some(item => item.id === person.id)) this.contextAliases.set(key, [...list, person]);
        } else if (!['uid', 'cliente_id', 'employee_id', 'live_name'].includes(alias.kind) && alias.value.length >= 4) this.addAlias(person, alias.kind, alias.value);
      }
    }
    const forms = new Map<string, { kind: string; original: string }>();
    for (const aliases of this.aliases.values()) for (const alias of aliases) forms.set(`${alias.kind}:${keyForm(alias.original)}`, { kind: alias.kind, original: alias.original });
    const ordered = [...forms.values()].sort((a, b) => b.original.length - a.original.length);
    this.matcher = ordered.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${ordered.map(a => aliasPattern(a.kind, a.original)).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : undefined;
    const contextValues = [...this.contextAliases.keys()].sort((a, b) => b.length - a.length);
    this.contextMatcher = contextValues.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${contextValues.map(aliasFragment).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : undefined;
  }
  private contextPeople(text: string): Person[] {
    const found = new Map<string, Person>();
    if (this.contextMatcher) {
      this.contextMatcher.lastIndex = 0;
      for (const match of text.matchAll(this.contextMatcher)) for (const person of this.contextAliases.get(keyForm(match[0])) ?? []) found.set(person.id, person);
    }
    for (const match of text.matchAll(/\b(?:CL-\d+|KP-\d+)\b/gi)) {
      const person = this.store.byAlias(match[0].toUpperCase().startsWith('CL-') ? 'cliente_id' : 'employee_id', match[0]);
      if (person) found.set(person.id, person);
    }
    for (const span of detectExplicit(text).filter(item => item.strong)) {
      const value = span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value;
      const person = this.store.byAlias(span.kind, value);
      if (person) found.set(person.id, person);
    }
    return [...found.values()];
  }
  private selfReferencedPeople(text: string): Person[] {
    const found = new Map<string, Person>();
    const selfCue = /\b(?:mi|my)\s+(?:correo|email|celular|tel[eé]fono|m[oó]vil|documento|c[eé]dula|placa|pasaporte|cuenta)\b[^.!?]{0,45}$/i;
    for (const span of detectExplicit(text).filter(item => item.strong)) {
      if (!selfCue.test(text.slice(Math.max(0, span.start - 55), span.start))) continue;
      const value = span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value;
      const person = this.store.byAlias(span.kind, value);
      if (person && person.identifiers.some(alias => ['cliente_id', 'employee_id'].includes(alias.kind))) found.set(person.id, person);
    }
    return [...found.values()];
  }
  private addAlias(person: Person, kind: string, original: string): void {
    const key = keyForm(original);
    const alias = { person, kind, original };
    const add = (index: string) => { const list = this.aliases.get(index) ?? []; if (!list.some(item => item.person.id === person.id && item.kind === kind && item.original === original)) this.aliases.set(index, [...list, alias]); };
    add(key);
    if (digitAliases.has(kind)) add(original.replace(/\D/g, ''));
  }
  registerCorpus(data: Ingested): void {
    const reserved: string[] = [];
    for (const row of data.tables) {
      const c = row.columns;
      for (const key of ['nombre_completo', 'nombre', 'correo', 'email', 'celular', 'telefono', 'num_doc', 'documento', 'direccion', 'fecha_nacimiento', 'placa', 'pasaporte', 'cuenta']) if (c[key]) reserved.push(c[key]);
    }
    for (const user of data.users) {
      if (!user.is_bot) reserved.push(user.real_name ?? user.profile?.real_name ?? user.name ?? '');
      if (user.profile?.email) reserved.push(user.profile.email);
    }
    for (const record of [...data.chats, ...data.docs]) {
      const texts = 'author' in record ? [record.author, record.text, ...record.attachments.map(a => a.filename)] : [record.filename, record.title, record.body, ...Object.values(record.metadata)];
      for (const value of texts) for (const span of detectExplicit(value)) if (span.kind !== 'name' || isFullName(span.value)) reserved.push(span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value);
    }
    this.store.reserveOriginals(reserved);
    const plans = planIndirect(data.tables);
    for (const row of data.tables.filter(r => r.table === 'clientes')) {
      const c = row.columns; const person = this.store.create('cliente_id', c.cliente_id, c.nombre_completo, c.pais ?? c.nacionalidad ?? c.country);
      const plan = plans.get(c.cliente_id); if (plan) { this.indirect.set(person.id, plan); this.store.setIndirect(person.id, plan); }
      for (const [kind, value] of [['email', c.correo], ['phone', c.celular], ['cedula', c.num_doc], ['address', c.direccion]]) if (value) this.store.addAlias(person.id, kind, value);
    }
    for (const row of data.tables.filter(r => r.table === 'empleados')) {
      const c = row.columns; const person = this.store.create('employee_id', c.id, c.nombre, c.pais ?? c.nacionalidad ?? c.country);
      for (const [kind, value] of [['email', c.correo], ['phone', c.celular], ['cedula', c.documento]]) if (value) this.store.addAlias(person.id, kind, value);
    }
    for (const row of data.tables.filter(r => r.table === 'transacciones' || r.table === 'pqrs')) {
      const c = row.columns; const person = c.cliente_id ? this.store.byAlias('cliente_id', c.cliente_id) : undefined;
      if (!person) continue;
      if (c.tx_id) this.store.addAlias(person.id, 'tx_id', c.tx_id);
      if (c.radicado) this.store.addAlias(person.id, 'radicado', c.radicado);
    }
    for (const user of data.users) {
      if (user.is_bot) continue;
      const name = user.real_name ?? user.profile?.real_name ?? user.name ?? user.id;
      const email = user.profile?.email;
      let person = email ? this.store.byAlias('email', email) : undefined;
      if (!person) person = this.store.create('uid', user.id, name);
      this.store.addAlias(person.id, 'uid', user.id);
      if (email) this.store.addAlias(person.id, 'email', email);
    }
    const messagesByUid = new Map<string, string[]>();
    for (const message of data.chats) {
      const uid = data.uidByChat.get(message.id);
      if (uid) { const messages = messagesByUid.get(uid) ?? []; messages.push([message.text, ...message.attachments.map(a => a.filename)].join(' ')); messagesByUid.set(uid, messages); }
    }
    this.rebuild();
    for (const user of data.users) {
      if (user.is_bot) continue;
      const current = this.store.byAlias('uid', user.id);
      if (!current || current.identifiers.some(a => a.kind === 'cliente_id' || a.kind === 'employee_id')) continue;
      const ownText = (messagesByUid.get(user.id) ?? []).join('\n');
      const supported = this.selfReferencedPeople(ownText);
      if (supported.length === 1) this.store.moveAlias('uid', user.id, supported[0].id);
    }
    this.rebuild();
    for (const record of [...data.chats, ...data.docs]) {
      const values = 'author' in record ? [record.text, ...record.attachments.map(a => a.filename)] : [record.filename, record.title, record.body, ...Object.values(record.metadata)];
      const metadataAuthor = 'metadata' in record ? record.metadata.author : undefined;
      if (metadataAuthor && isFullName(metadataAuthor) && !metadataAuthor.includes('@') && !isKeptName(metadataAuthor) && !this.knownName(metadataAuthor)) this.store.create('live_name', `${record.id}:${keyForm(metadataAuthor)}`, metadataAuthor);
      for (const value of values) {
        const spans = detectExplicit(value);
        const introduced = spans.find(span => span.kind === 'name')?.value;
        let strongPerson: Person | undefined;
        for (const span of spans.filter(span => span.strong)) {
          const canonical = span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value;
          strongPerson = this.store.byAlias(span.kind, canonical) ?? this.store.create(span.kind, canonical, introduced ?? '');
        }
        for (const span of spans.filter(span => span.kind === 'name' && !isKeptName(span.value))) {
          if (this.knownName(span.value) || strongPerson && keyForm(strongPerson.name) === keyForm(span.value)) continue;
          this.store.create('live_name', `${record.id}:${keyForm(span.value)}`, span.value);
        }
      }
    }
    this.rebuild();
    this.buildThreadContexts(data.chats, data.uidByChat);
  }
  registerLive(records: RecordValue[]): void {
    const reserved: string[] = [];
    for (const record of records) {
      if ('author' in record) {
        reserved.push(record.author);
        for (const span of detectExplicit(record.text)) if (span.kind !== 'name' || isFullName(span.value)) reserved.push(span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value);
      } else if ('table' in record) {
        for (const [key, value] of Object.entries(record.columns)) if (privateFields[key.toLowerCase()] && value) reserved.push(value);
      } else {
        for (const value of [record.filename, record.title, record.body, ...Object.values(record.metadata)]) for (const span of detectExplicit(value)) if (span.kind !== 'name' || isFullName(span.value)) reserved.push(span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value);
      }
    }
    this.store.reserveOriginals(reserved);
    for (const record of records) {
      if ('author' in record && isFullName(record.author)) {
        const selfSpans = detectExplicit(record.text).filter(span => span.strong && /\b(?:mi|my)\s+(?:correo|email|celular|tel[eé]fono|documento|c[eé]dula)\b/i.test(record.text.slice(Math.max(0, span.start - 40), span.start)));
        if (selfSpans.length === 1) {
          const span = selfSpans[0]; const value = span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value;
          const person = this.store.byAlias(span.kind, value) ?? this.store.create(span.kind, value, record.author);
          this.store.addAlias(person.id, span.kind, value);
        }
      }
      if (!('table' in record)) continue;
      const c = record.columns;
      let person: Person | undefined;
      if (record.table === 'clientes' && c.cliente_id && c.nombre_completo) person = this.store.create('cliente_id', c.cliente_id, c.nombre_completo, c.pais ?? c.nacionalidad ?? c.country);
      if (record.table === 'empleados' && c.id && c.nombre) person = this.store.create('employee_id', c.id, c.nombre, c.pais ?? c.nacionalidad ?? c.country);
      if (!person) continue;
      for (const [kind, value] of [['email', c.correo], ['phone', c.celular], ['cedula', c.num_doc ?? c.documento], ['address', c.direccion]]) if (value) this.store.addAlias(person.id, kind, value);
    }
    this.rebuild();
  }
  private knownName(value: string, context?: Person, role?: 'employee' | 'customer'): Person | undefined {
    const matches = (this.names.get(keyForm(value)) ?? []).filter(p => !role || p.identifiers.some(a => a.kind === (role === 'employee' ? 'employee_id' : 'cliente_id')));
    if (context && matches.some(p => p.id === context.id)) return context;
    return matches.length === 1 ? matches[0] : undefined;
  }
  private byValue(value: string, context?: Person, role?: 'employee' | 'customer'): Person | undefined {
    for (const kind of ['email', 'phone', 'cedula', 'uid', 'plate', 'passport']) { const person = this.store.byAlias(kind, value); if (person) return person; }
    return this.knownName(value, context, role);
  }
  private context(record: RecordValue, uid?: string): Person | undefined {
    if (uid) { const person = this.store.byAlias('uid', uid); if (person) return person; }
    if ('table' in record) {
      const c = record.columns;
      if (record.table === 'empleados' && c.id) return this.store.byAlias('employee_id', c.id);
      if (c.cliente_id) return this.store.byAlias('cliente_id', c.cliente_id);
      if (c.correo) return this.store.byAlias('email', c.correo);
    }
    if ('author' in record) {
      const known = this.byValue(record.author); if (known) return known;
      const strong = new Set(detectExplicit(record.text).filter(span => span.strong).map(span => this.store.byAlias(span.kind, span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value)?.id).filter((id): id is string => !!id));
      if (strong.size === 1) {
        const person = this.store.byId([...strong][0]);
        if (person && keyForm(person.name) === keyForm(record.author)) return person;
      }
    }
    return undefined;
  }
  private createLive(kind: string, value: string, recordId: string, name?: string): Person {
    if (kind === 'name') {
      const known = this.knownName(value);
      if (known) return known;
    }
    const aliasKind = kind === 'name' ? 'live_name' : kind;
    const key = kind === 'name' ? `${recordId}:${keyForm(value)}` : value;
    const person = this.store.byAlias(aliasKind, key) ?? this.store.create(aliasKind, key, name ?? (kind === 'name' ? value : ''));
    if (kind !== 'name') this.store.addAlias(person.id, kind, value);
    this.rebuild();
    return person;
  }
  private explicitPerson(span: DetectedSpan, recordId: string, input: string, context?: Person, introduced?: string): Person | undefined {
    const value = span.kind === 'email' ? canonicalSpokenEmail(span.value) : span.value;
    if (span.kind === 'first_name') return context && keyForm(context.name).split(' ')[0] === keyForm(value) ? context : undefined;
    const known = this.store.byAlias(span.kind, value) ?? (span.kind === 'name' ? this.knownName(value, context) : undefined);
    if (known) return known;
    if (span.kind === 'name' && isKeptName(value)) return undefined;
    const preceding = input.slice(Math.max(0, span.start - 45), span.start);
    const selfReference = /\b(?:mi|my)\s+(?:correo|email|celular|tel[eé]fono|documento|c[eé]dula|placa|pasaporte)\b[^.!?]*$/i.test(preceding);
    if (context && span.kind !== 'name' && (selfReference || (introduced && keyForm(introduced) === keyForm(context.name)))) { this.store.addAlias(context.id, span.kind, value); return context; }
    return this.createLive(span.kind, value, recordId, introduced);
  }
  private replaceText(input: string, recordId: string, context?: Person, related: Person[] = []): string {
    if (!input) return input;
    const edits: Edit[] = [];
    const spans = detectExplicit(input); const introduced = spans.find(s => s.kind === 'name')?.value;
    const strong = new Set(spans.filter(s => s.strong).map(s => this.store.byAlias(s.kind, s.kind === 'email' ? canonicalSpokenEmail(s.value) : s.value)?.id).filter((id): id is string => !!id));
    for (const match of input.matchAll(/\b(?:CL-\d+|KP-\d+)\b/gi)) {
      const person = this.store.byAlias(match[0].toUpperCase().startsWith('CL-') ? 'cliente_id' : 'employee_id', match[0]);
      if (person) strong.add(person.id);
    }
    for (const person of this.contextPeople(input)) strong.add(person.id);
    const local = strong.size === 1 ? this.store.byId([...strong][0]) : context;
    const anchoredIds = new Set([...(context ? [context.id] : []), ...related.map(person => person.id), ...(strong.size === 1 ? [...strong] : [])]);
    const indirect = local ? this.indirect.get(local.id) : undefined;
    if (indirect?.occupation && indirect.neighborhoodContext && keyForm(input).includes(keyForm(indirect.occupation.original)) && keyForm(input).includes(keyForm(indirect.neighborhoodContext))) {
      for (const match of input.matchAll(/(?<![\d/-])(?:19|20)\d{2}(?![\d/-])/g)) edits.push({ start: match.index, end: match.index + match[0].length, original: match[0], text: 'hace unos años', person: local!, priority: 3, quasi: true });
    }
    if (indirect) for (const item of [indirect.occupation, indirect.neighborhood]) {
      if (!item) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${aliasFragment(item.original)}(?![\\p{L}\\p{N}])`, 'giu');
      for (const match of input.matchAll(pattern)) edits.push({ start: match.index, end: match.index + match[0].length, original: match[0], text: item.replacement, person: local!, priority: 3, quasi: true });
    }
    for (const span of [...spans.filter(s => s.strong), ...spans.filter(s => !s.strong)]) {
      const person = this.explicitPerson(span, recordId, input, local, introduced);
      if (!person) continue;
      const pseudo = span.kind === 'name' ? person.pseudonym : span.kind === 'first_name' ? person.pseudonym.split(' ')[0] : this.store.pseudonym(person.id, span.kind, span.value);
      const piiKind = span.kind === 'first_name' ? 'name' : span.kind;
      edits.push({ start: span.start, end: span.end, original: span.value, text: formatLike(span.value, pseudo, piiKind), person, priority: 5, kind: piiKind });
    }
    if (this.matcher) for (const match of input.matchAll(this.matcher)) {
      const aliases = this.aliases.get(keyForm(match[0])) ?? this.aliases.get(keyForm(match[0].replace(/[_-]+/g, ' '))) ?? this.aliases.get(match[0].replace(/\D/g, '')) ?? [];
      const anchoredFirstNames = aliases.filter(a => a.kind === 'first_name' && anchoredIds.has(a.person.id));
      let chosen = anchoredFirstNames.length === 1 ? anchoredFirstNames[0] : aliases.find(a => a.person.id === local?.id) ?? (aliases.length === 1 ? aliases[0] : undefined);
      if (chosen?.kind === 'first_name' && !anchoredIds.has(chosen.person.id)) continue;
      if (!chosen && aliases.length) {
        if (aliases[0].kind === 'first_name') continue;
        const kind = aliases[0].kind;
        const person = this.createLive(kind, match[0], recordId);
        chosen = { person, kind, original: match[0] };
      }
      if (!chosen) continue;
      const pseudo = chosen.kind === 'name' ? chosen.person.pseudonym : chosen.kind === 'first_name' ? chosen.person.pseudonym.split(' ')[0] : this.store.pseudonym(chosen.person.id, chosen.kind, chosen.original);
      const piiKind = chosen.kind === 'first_name' ? 'name' : chosen.kind;
      edits.push({ start: match.index, end: match.index + match[0].length, original: match[0], text: formatLike(match[0], pseudo, piiKind), person: chosen.person, priority: chosen.person.id === local?.id ? 4 : 2, kind: piiKind });
    }
    for (const match of input.matchAll(/<@([A-Z0-9]+)>/g)) {
      const person = this.store.byAlias('uid', match[1]); if (!person) continue;
      edits.push({ start: match.index, end: match.index + match[0].length, original: match[0], text: `@${person.pseudonym.replace(/ /g, '_')}`, person, priority: 5 });
    }
    edits.sort((a, b) => b.priority - a.priority || (b.end - b.start) - (a.end - a.start));
    const selected: Edit[] = [];
    for (const edit of edits) if (!selected.some(s => edit.start < s.end && edit.end > s.start)) selected.push(edit);
    let result = input;
    for (const edit of selected.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      if (!edit.quasi) this.store.addOriginal(edit.person.id, edit.original, edit.kind ?? 'name');
      this.mark(edit.person, recordId, edit.kind);
    }
    return result;
  }
  private field(value: string, key: string, recordId: string, context?: Person): string {
    if (context && (key === 'ocupacion' || key === 'barrio')) {
      const plan = this.indirect.get(context.id);
      const item = key === 'ocupacion' ? plan?.occupation : plan?.neighborhood;
      if (item && keyForm(item.original) === keyForm(value)) {
        this.mark(context, recordId);
        return item.replacement;
      }
    }
    const kind = key.toLowerCase() === 'author' && (value.includes('@') || /\s+arroba\s+/i.test(value)) ? 'email' : privateFields[key.toLowerCase()];
    if (!kind || !value.trim()) return this.replaceText(value, recordId, context);
    if (key.toLowerCase() === 'author' && isKeptName(value)) return value;
    const role = key === 'agente' || key === 'reporta_a' ? 'employee' : undefined;
    let person = this.byValue(value, context, role) ?? (role ? undefined : context);
    if (!person && kind === 'name' && isFullName(value)) person = this.createLive('name', value, recordId);
    if (!person) return this.replaceText(value, recordId, context);
    this.store.addOriginal(person.id, value, kind); this.mark(person, recordId, kind);
    return formatLike(value, kind === 'name' ? person.pseudonym : this.store.pseudonym(person.id, kind, value), kind);
  }
  anonymize<T extends RecordValue>(record: T, uid?: string): T {
    const output = structuredClone(record); let context = this.context(record, uid);
    if ('author' in output) {
      const related = this.threadContexts.get(output.thread_id);
      output.thread_id = this.replaceText(output.thread_id, output.id, context);
      let author = this.byValue(output.author, context) ?? context;
      if (!author && !uid && isFullName(output.author) && !isKeptName(output.author)) author = this.createLive('name', output.author, output.id);
      if (author) { output.author = caseLike(output.author, author.pseudonym); this.mark(author, output.id, 'name'); context = author; }
      const anchors = related && related.id !== context?.id ? [related] : [];
      output.text = this.replaceText(output.text, output.id, context, anchors);
      output.attachments = output.attachments.map(a => ({ filename: this.replaceText(a.filename, output.id, context, anchors) }));
    } else if ('body' in output) {
      output.filename = this.replaceText(output.filename, output.id);
      output.title = this.replaceText(output.title, output.id);
      output.body = this.replaceText(output.body, output.id);
      output.metadata = Object.fromEntries(Object.entries(output.metadata).map(([key, value]) => [key, this.field(value, key, output.id)]));
    } else {
      output.columns = Object.fromEntries(Object.entries(output.columns).map(([key, value]) => [key, stableFields.has(key) ? value : this.field(value, key, output.id, context)]));
    }
    return output;
  }
}
