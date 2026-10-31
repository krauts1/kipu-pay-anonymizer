import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityStore } from './identity.js';
import { findLeaks } from './leak-audit.js';
import { Anonymizer } from './anonymize.js';
import { anonymizeLive } from './pipeline.js';
import type { Ingested } from './source.js';
import type { RecordValue } from './types.js';

async function withStore(run: (store: IdentityStore) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-qa-'));
  const store = new IdentityStore(join(directory, 'identities.sqlite'));
  try { run(store); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('original data retains its detected type for auditing', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90001', 'Synthetic Person');
  store.addAlias(person.id, 'phone', '300 555 0101');
  const originals = store.knownOriginals();
  assert.equal(originals.find(item => item.value === '300 555 0101')?.kind, 'phone');
  const record: RecordValue = { id: 'chat-1', thread_id: 'thread-1', author: 'Synthetic Person', ts: '0', text: 'Call 300-555-0101', attachments: [] };
  assert.ok(findLeaks([record], store).some(leak => leak.kind === 'phone'));
  const filename: RecordValue = { id: 'chat-2', thread_id: 'thread-2', author: '', ts: '0', text: '', attachments: [{ filename: 'scan_3005550101_v2.pdf' }] };
  assert.ok(findLeaks([filename], store).some(leak => leak.kind === 'phone'));
}));

test('new corpus reservations never rename a previously issued pseudonym', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-stability-'));
  const db = join(directory, 'identities.sqlite');
  const first = new IdentityStore(db);
  const existing = first.create('cliente_id', 'CL-90002', 'Synthetic Customer');
  const issuedName = existing.pseudonym;
  first.close();
  const expanded = new IdentityStore(db);
  try {
    expanded.reserveOriginals(['Some New Corpus Value']);
    expanded.create('cliente_id', 'CL-90003', 'Another Synthetic Customer');
    assert.equal(expanded.byId(existing.id)?.pseudonym, issuedName);
  } finally { expanded.close(); await rm(directory, { recursive: true, force: true }); }
});

test('email pseudonyms use a neutral stable alias and preserve an approved domain', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90009', 'Synthetic Person');
  const pseudonym = store.pseudonym(person.id, 'email', 'original.person@gmail.com');
  assert.equal(pseudonym.split('@')[1], 'gmail.com');
  assert.match(pseudonym, /^contacto\d+@gmail\.com$/);
  assert.notEqual(pseudonym, 'original.person@gmail.com');
}));

test('auditor ignores title-case ambiguous words but catches lower-case first-name leaks and full names', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90004', 'Synthetic Person');
  const record: RecordValue = { id: 'doc-1', format: 'md', filename: 'doc.md', title: 'Ana', body: 'The customer is Synthetic Person.', metadata: {} };
  assert.ok(findLeaks([record], store).some(leak => leak.personId === person.id));
  const short = store.create('cliente_id', 'CL-90005', 'Ana');
  store.addAlias(short.id, 'name', 'Ana');
  assert.ok(!findLeaks([record], store).some(leak => leak.personId === short.id));
  const lowerName = { ...record, body: 'El caso lo revisó camilo.' };
  const camilo = store.create('cliente_id', 'CL-90012', 'camilo');
  assert.ok(findLeaks([lowerName], store).some(leak => leak.personId === camilo.id));
}));

test('a repair alias survives matcher rebuild and is applied on the next pass', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90006', 'Synthetic Person');
  const engine = new Anonymizer(store);
  const unmasked = 'Synthetic Person';
  engine.repair([{ personId: person.id, value: unmasked, kind: 'name' }]);
  const record: RecordValue = { id: 'chat-2', thread_id: 'thread-2', author: 'Support Agent', ts: '0', text: `${unmasked} requested support.`, attachments: [] };
  assert.ok(engine.anonymize(record).text.includes(person.pseudonym));
}));

test('live processing uses the same audit gate for a batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-live-'));
  try {
    const record: RecordValue = { id: 'doc-2', format: 'md', filename: 'sample.md', title: 'Support note', body: 'Cédula: 123456789', metadata: {} };
    const output = anonymizeLive('docs', [record], join(directory, 'identities.sqlite'));
    assert.ok(!JSON.stringify(output.records).includes('123456789'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live chat reuses a person already registered from a table record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-live-link-'));
  const db = join(directory, 'identities.sqlite');
  try {
    const table: RecordValue = { id: 'clientes:CL-90010', table: 'clientes', columns: { cliente_id: 'CL-90010', nombre_completo: 'Synthetic Customer', correo: 'customer@example.test', celular: '3005550110', num_doc: '400000010', pais: 'Colombia' } };
    const first = anonymizeLive('tables', [table], db);
    const person = first.entities.find(entity => entity.type === 'person');
    assert.ok(person?.pseudonyms?.name);
    const chat: RecordValue = { id: 'chat-6', thread_id: 'thread-6', author: 'Synthetic Customer', ts: '0', text: 'Necesito ayuda.', attachments: [] };
    const second = anonymizeLive('chats', [chat], db);
    assert.equal(second.records[0] && 'author' in second.records[0] ? second.records[0].author : undefined, person.pseudonyms.name);
    assert.equal(second.entities.filter(entity => entity.type === 'person').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a unique transaction reference anchors first-name replacement in its thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-thread-link-'));
  const store = new IdentityStore(join(directory, 'identities.sqlite'));
  try {
    const data: Ingested = {
      chats: [
        { id: 'chat-root', thread_id: 'support:root', author: 'Support Agent', ts: '0', text: 'La referencia TX-987654 pertenece a la consulta.', attachments: [] },
        { id: 'chat-reply', thread_id: 'support:root', author: 'Support Agent', ts: '1', text: 'Hola Yesenia.', attachments: [] },
      ],
      docs: [],
      tables: [
        { id: 'clientes:CL-90011', table: 'clientes', columns: { cliente_id: 'CL-90011', nombre_completo: 'Yesenia Synthetic', correo: 'yesenia@example.test', celular: '3005550111', num_doc: '400000011', pais: 'Colombia' } },
        { id: 'transacciones:TX-987654', table: 'transacciones', columns: { tx_id: 'TX-987654', cliente_id: 'CL-90011' } },
      ],
      users: [{ id: 'U_AGENT', real_name: 'Support Agent', is_bot: false }],
      uidByChat: new Map([['chat-root', 'U_AGENT'], ['chat-reply', 'U_AGENT']]),
      index: { chats: ['chat-root', 'chat-reply'], docs: [], tables: ['clientes:CL-90011', 'transacciones:TX-987654'] },
    };
    const engine = new Anonymizer(store);
    engine.registerCorpus(data);
    const customer = store.byAlias('cliente_id', 'CL-90011');
    assert.ok(customer);
    const reply = engine.anonymize(data.chats[1], 'U_AGENT');
    assert.equal(reply.text, `Hola ${customer.pseudonym.split(' ')[0]}.`);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a unique first name without local context reuses its person pseudonym', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90007', 'Camila Synthetic');
  const engine = new Anonymizer(store);
  const record: RecordValue = { id: 'chat-3', thread_id: 'thread-3', author: 'Support Agent', ts: '0', text: 'Camila sent a message.', attachments: [] };
  assert.equal(engine.anonymize(record).text, `${person.pseudonym.split(' ')[0]} sent a message.`);
  const lower = { ...record, id: 'chat-3b', text: 'camila sent a message.' };
  assert.equal(engine.anonymize(lower).text, `${person.pseudonym.split(' ')[0].toLowerCase()} sent a message.`);
}));

test('an ambiguous first name is neutralized without linking either homonym', async () => withStore(store => {
  store.create('cliente_id', 'CL-90013', 'Camila Uno');
  store.create('cliente_id', 'CL-90014', 'Camila Dos');
  const engine = new Anonymizer(store);
  const record: RecordValue = { id: 'chat-3c', thread_id: 'thread-3c', author: 'Support Agent', ts: '0', text: 'Hola Camila, ya revisé tu caso.', attachments: [] };
  assert.equal(engine.anonymize(record).text, 'Hola [persona], ya revisé tu caso.');
}));

test('a single-name employee column is replaced in its source table', async () => withStore(store => {
  const employee: RecordValue = { id: 'empleados:KP-90015', table: 'empleados', columns: { id: 'KP-90015', nombre: 'camilo', cargo: 'support agent' } };
  const engine = new Anonymizer(store);
  engine.registerCorpus({ chats: [], docs: [], tables: [employee], users: [], uidByChat: new Map(), index: { chats: [], docs: [], tables: [employee.id] } });
  const output = engine.anonymize(employee);
  assert.notEqual('table' in output ? output.columns.nombre : undefined, 'camilo');
}));

test('a first name in a greeting reuses the known person pseudonym', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90008', 'Yesenia Synthetic');
  const engine = new Anonymizer(store);
  const local: RecordValue = { id: 'chat-4', thread_id: 'thread-4', author: 'Yesenia Synthetic', ts: '0', text: 'Hola Yesenia, soy Yesenia.', attachments: [] };
  assert.equal(engine.anonymize(local).text, `Hola ${person.pseudonym.split(' ')[0]}, soy ${person.pseudonym.split(' ')[0]}.`);
  const other: RecordValue = { id: 'chat-5', thread_id: 'thread-5', author: 'Support Agent', ts: '0', text: 'Hola Yesenia.', attachments: [] };
  assert.equal(engine.anonymize(other).text, `Hola ${person.pseudonym.split(' ')[0]}.`);
}));

test('PII variants in uppercase, spoken email, numbers, HTML comments and PDF metadata are replaced', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90101', 'Andrés Quintero', 'Colombia');
  store.addAlias(person.id, 'email', 'andres.quintero@example.test');
  store.addAlias(person.id, 'phone', '3005550101');
  store.addAlias(person.id, 'cedula', '12345678');
  store.addAlias(person.id, 'plate', 'ABC123');
  store.addAlias(person.id, 'passport', 'AB1234567');
  const engine = new Anonymizer(store);
  const input: RecordValue = {
    id: 'doc-pii-regression', format: 'pdf', filename: 'extracto.pdf', title: 'Extracto',
    body: '<!-- Andrés Quintero --> <div data-author="Andrés Quintero">ANDRES QUINTERO</div> correo andres punto quintero arroba example punto test; celular 300-555-0101; cédula 12.345.678; placa ABC-123; pasaporte AB1234567.',
    metadata: { author: 'Andrés Quintero' },
  };
  const output = engine.anonymize(input);
  assert.equal(output.id, input.id);
  assert.ok(!JSON.stringify(output).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('andres quintero'));
  assert.ok(!JSON.stringify(output).includes('12345678'));
  assert.ok(!JSON.stringify(output).includes('3005550101'));
  assert.ok(!JSON.stringify(output).includes('AB1234567'));
  assert.ok(!JSON.stringify(output).includes('ABC-123'));
  assert.ok(output.body.includes('Nequi') === false);
}));

test('homonymous people keep separate identities and business names remain intact', async () => withStore(store => {
  const data: Ingested = {
    chats: [], docs: [], users: [], uidByChat: new Map(),
    tables: [
      { id: 'clientes:CL-90102', table: 'clientes', columns: { cliente_id: 'CL-90102', nombre_completo: 'Camila Rojas', pais: 'Colombia' } },
      { id: 'clientes:CL-90103', table: 'clientes', columns: { cliente_id: 'CL-90103', nombre_completo: 'Camila Rojas', pais: 'Colombia' } },
    ],
    index: { chats: [], docs: [], tables: ['clientes:CL-90102', 'clientes:CL-90103'] },
  };
  const engine = new Anonymizer(store); engine.registerCorpus(data);
  const first = engine.anonymize(data.tables[0]); const second = engine.anonymize(data.tables[1]);
  assert.equal(first.id, data.tables[0].id); assert.equal(second.id, data.tables[1].id);
  assert.notEqual('table' in first ? first.columns.nombre_completo : '', 'table' in second ? second.columns.nombre_completo : '');
  const businesses: RecordValue = { id: 'chat-kept', thread_id: 'support:1', author: 'Agente', ts: '1', text: 'Nequi opera en Bogotá y Shakira es una figura pública.', attachments: [] };
  assert.equal(engine.anonymize(businesses).text, businesses.text);
}));

test('Slack uid and table identity use the same pseudonym across sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-slack-link-'));
  const store = new IdentityStore(join(directory, 'identities.sqlite'));
  try {
    const table: RecordValue = { id: 'clientes:CL-90104', table: 'clientes', columns: { cliente_id: 'CL-90104', nombre_completo: 'Valeria Synthetic', correo: 'valeria@example.test', pais: 'Colombia' } };
    const chat: RecordValue = { id: 'chat-slack-link', thread_id: 'support:9', author: 'Valeria Synthetic', ts: '1', text: 'Te mencionó <@UVALERIA>.', attachments: [] };
    const data: Ingested = { chats: [chat as Extract<RecordValue, { author: string }>], docs: [], tables: [table as Extract<RecordValue, { table: string }>], users: [{ id: 'UVALERIA', name: 'Valeria Synthetic', profile: { email: 'valeria@example.test' } }], uidByChat: new Map([[chat.id, 'UVALERIA']]), index: { chats: [chat.id], docs: [], tables: [table.id] } };
    const engine = new Anonymizer(store); engine.registerCorpus(data);
    const person = store.byAlias('cliente_id', 'CL-90104'); assert.ok(person);
    const output = engine.anonymize(chat, 'UVALERIA');
    assert.equal(output.author, person.pseudonym);
    assert.ok(output.text.includes(`@${person.pseudonym.replace(/ /g, '_')}`));
    assert.equal(output.id, chat.id);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unique neighborhood, occupation and year are generalized together', async () => withStore(store => {
  const row: RecordValue = { id: 'clientes:CL-90105', table: 'clientes', columns: { cliente_id: 'CL-90105', nombre_completo: 'Lucía Synthetic', ciudad: 'Barranquilla', barrio: 'Barrio Faro', ocupacion: 'contadora', pais: 'Colombia' } };
  const engine = new Anonymizer(store);
  engine.registerCorpus({ chats: [], docs: [], tables: [row], users: [], uidByChat: new Map(), index: { chats: [], docs: [], tables: [row.id] } });
  const output = engine.anonymize(row);
  assert.equal(output.columns.barrio, 'sector de la ciudad');
  assert.notEqual(output.columns.ocupacion, 'contadora');
  const chat: RecordValue = { id: 'chat-indirect', thread_id: 'support:10', author: 'Agente', ts: '1', text: 'CL-90105 trabaja como contadora en Barrio Faro desde 2021.', attachments: [] };
  const anonymized = engine.anonymize(chat);
  assert.ok(anonymized.text.includes('hace unos años'));
  assert.ok(!anonymized.text.includes('contadora'));
  assert.ok(!anonymized.text.includes('Barrio Faro'));
}));
