import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.ts';

const root = process.cwd();
const sourcesUrl = process.env.FUENTES_URL ?? 'https://reto-pii-fuentes-production.up.railway.app/v1';
let token = process.env.FUENTES_TOKEN;
if (!token) {
  try { token = (await readFile(join(root, '.fuentes-token'), 'utf8')).trim(); }
  catch { throw new Error('Set FUENTES_TOKEN or provide the ignored .fuentes-token file for local public QA. No Frontier evaluation is called.'); }
}
if (!token) throw new Error('The source token is empty. No Frontier evaluation is called.');

function check(ok, id) { if (!ok) throw new Error(`${id} failed; details suppressed to avoid printing source values`); }
function fold(value) { return value.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function allText(records) { return JSON.stringify(records); }
function digitPayloadPresent(text, payload) {
  const digits = payload.replace(/\D/g, '');
  if (!digits) return false;
  const compact = text.replace(/(?<=\p{Nd})[\s.,'’`´·/\-–—_]+(?=\p{Nd})/gu, '');
  return new RegExp(`(?<!\\p{Nd})(?:57)?${digits}(?!\\p{Nd})`, 'u').test(compact);
}
function entityMatches(entity, value) {
  const needle = fold(value).replace(/[^\p{L}\p{N}@.]+/gu, '');
  return (entity.originals ?? []).some(original => {
    const candidate = fold(original).replace(/[^\p{L}\p{N}@.]+/gu, '');
    return candidate === needle || candidate.startsWith(needle) || needle.startsWith(candidate);
  });
}

const temporary = await mkdtemp(join(tmpdir(), 'frontier-public-qa-'));
try {
  const outputDir = join(temporary, 'output');
  const counts = await runPipeline(sourcesUrl, token, outputDir, join(temporary, 'identities.sqlite'));
  let validatorOutput = '';
  try {
    validatorOutput = execFileSync(process.execPath, [join(root, 'material-oficial/validar.mjs'), outputDir, '--public', join(root, 'material-oficial')], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    const output = String(error.stdout ?? '');
    const count = output.match(/FALLA: (\d+) problema/);
    const lines = output.split('\n').filter(line => line.startsWith(' - '));
    const categories = new Map();
    for (const line of lines) {
      const category = line.includes('sigue en la salida') ? 'original-form-leak'
        : line.includes('no aparece en ninguno') ? 'pseudonym-not-present'
        : line.includes('referencia un registro inexistente') ? 'invalid-record-reference'
        : line.includes('id repetido') ? 'duplicate-id'
        : line.includes('sin campo') ? 'missing-entity-field'
        : line.includes('no conservada') ? 'kept-entity-missing-pseudonym'
        : 'other-validator-rule';
      categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    const fieldHits = new Map();
    try {
      const entities = JSON.parse(await readFile(join(outputDir, 'entities.json'), 'utf8')).entities;
      const all = [];
      for (const kind of ['chats', 'docs', 'tables']) for (const line of (await readFile(join(outputDir, `${kind}.jsonl`), 'utf8')).trim().split('\n')) {
        const record = JSON.parse(line);
        const walk = (value, path) => {
          if (typeof value === 'string') all.push([`${kind}.${path}`, value]);
          else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) if (key !== 'id') walk(child, path ? `${path}.${key}` : key);
        };
        walk(record, '');
      }
      for (const line of lines.filter(item => item.includes('la forma original'))) {
        const id = line.match(/entities\[([^\]]+)\]/)?.[1];
        const entity = entities.find(item => item.entity_id === id);
        for (const original of entity?.originals ?? []) {
          if (original.length < 3 || (!original.includes(' ') && !original.includes('@') && !/\d/.test(original))) continue;
          const needle = fold(original);
          for (const [field, value] of all) if (fold(value).includes(needle)) fieldHits.set(field, (fieldHits.get(field) ?? 0) + 1);
        }
      }
    } catch { /* keep the validator failure summary safe */ }
    const locations = [...fieldHits].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([field, n]) => `${field}:${n}`).join(', ');
    throw new Error(`Local validator failed${count ? ` (${count[1]} issues)` : ''}: ${[...categories].map(([key, value]) => `${key}:${value}`).join(', ') || 'unclassified'}${locations ? `; likely fields ${locations}` : ''}; details suppressed`);
  }
  check(validatorOutput.includes('OK: la salida pasa el validador'), 'validar.mjs');

  const records = {};
  for (const kind of ['chats', 'docs', 'tables']) records[kind] = (await readFile(join(outputDir, `${kind}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const { entities } = JSON.parse(await readFile(join(outputDir, 'entities.json'), 'utf8'));
  const tests = JSON.parse(await readFile(join(root, 'material-oficial/tests_public.json'), 'utf8'));
  const byId = Object.fromEntries(Object.values(records).flat().map(record => [record.id, record]));
  const fullRecords = allText(Object.values(records).flat());

  const pub01 = tests.find(test => test.id === 'pub_01');
  const pub01Record = byId[pub01.locator.record];
  check(!!pub01Record && !fold(JSON.stringify(pub01Record.attachments)).includes(fold(pub01.payload[0])), 'pub_01');

  const pub02 = tests.find(test => test.id === 'pub_02');
  check(!digitPayloadPresent(fullRecords, pub02.payload[0]), 'pub_02');

  const pub03 = tests.find(test => test.id === 'pub_03');
  check(fold(byId[pub03.locator.record]?.text ?? '').includes(fold(pub03.payload[0])), 'pub_03');

  const pub04 = tests.find(test => test.id === 'pub_04');
  const homonyms = entities.filter(entity => entity.originals?.some(original => fold(original) === fold(pub04.payload[0])) && entity.pseudonyms?.name);
  check(homonyms.length >= 2 && new Set(homonyms.map(entity => entity.pseudonyms.name)).size >= 2, 'pub_04');

  const pub05 = tests.find(test => test.id === 'pub_05');
  const ownersByForm = pub05.lookup_forms.map(form => new Set(entities.filter(entity => entityMatches(entity, form)).map(entity => entity.entity_id)));
  const owners = new Set(ownersByForm.flatMap(set => [...set]));
  const ownerEntities = entities.filter(entity => owners.has(entity.entity_id));
  check(owners.size === 1 && ownersByForm.every(set => set.size === 1) && ownerEntities.length === 1 && !!ownerEntities[0].pseudonyms?.name, 'pub_05');

  process.stdout.write(`Local QA passed: validator + pub_01..pub_05; ${counts.chats} chats, ${counts.docs} docs, ${counts.tables} table rows. No Frontier evaluation was called.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
