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

test('auditor ignores ambiguous single names but catches full names', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90004', 'Synthetic Person');
  const record: RecordValue = { id: 'doc-1', format: 'md', filename: 'doc.md', title: 'Ana', body: 'The customer is Synthetic Person.', metadata: {} };
  assert.ok(findLeaks([record], store).some(leak => leak.personId === person.id));
  const short = store.create('cliente_id', 'CL-90005', 'Ana');
  store.addAlias(short.id, 'name', 'Ana');
  assert.ok(!findLeaks([record], store).some(leak => leak.personId === short.id));
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

test('a first name without person context is left unchanged', async () => withStore(store => {
  store.create('cliente_id', 'CL-90007', 'Camila Synthetic');
  const engine = new Anonymizer(store);
  const record: RecordValue = { id: 'chat-3', thread_id: 'thread-3', author: 'Support Agent', ts: '0', text: 'Camila sent a message.', attachments: [] };
  assert.equal(engine.anonymize(record).text, record.text);
}));

test('a first name in a greeting is replaced only for the local person', async () => withStore(store => {
  const person = store.create('cliente_id', 'CL-90008', 'Yesenia Synthetic');
  const engine = new Anonymizer(store);
  const local: RecordValue = { id: 'chat-4', thread_id: 'thread-4', author: 'Yesenia Synthetic', ts: '0', text: 'Hola Yesenia, soy Yesenia.', attachments: [] };
  assert.equal(engine.anonymize(local).text, `Hola ${person.pseudonym.split(' ')[0]}, soy ${person.pseudonym.split(' ')[0]}.`);
  const other: RecordValue = { id: 'chat-5', thread_id: 'thread-5', author: 'Support Agent', ts: '0', text: 'Hola Yesenia.', attachments: [] };
  assert.equal(engine.anonymize(other).text, other.text);
}));
