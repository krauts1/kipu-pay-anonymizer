import { createHash } from 'node:crypto';
import { keyForm } from './name-catalog.js';
import type { Entity, RecordValue } from './types.js';

const organizations = ['Kipu Pay', 'Frontier', 'Bancolombia', 'Davivienda', 'Banco de Bogotá', 'Nequi', 'Daviplata', 'Visa', 'Mastercard'];
const commonPlaces = ['Colombia', 'Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Cartagena', 'Bucaramanga', 'Pereira', 'Manizales', 'México', 'Estados Unidos', 'Reino Unido', 'Australia'];
const publicFigures = ['Shakira', 'Gabriel García Márquez', 'Lionel Messi', 'Frida Kahlo', 'Simón Bolívar'];
export function isKeptName(value: string): boolean { return [...organizations, ...commonPlaces, ...publicFigures].some(name => keyForm(name) === keyForm(value)); }
function strings(record: RecordValue): string[] {
  if ('author' in record) return [record.text, ...record.attachments.map(a => a.filename)];
  if ('body' in record) return [record.filename, record.title, record.body, ...Object.values(record.metadata)];
  return Object.values(record.columns);
}
function present(text: string, value: string): boolean {
  const pattern = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}
export function keptEntities(records: RecordValue[]): Entity[] {
  const names = new Map<string, { value: string; reason: string }>();
  for (const value of organizations) names.set(keyForm(value), { value, reason: 'organization or brand' });
  for (const value of commonPlaces) names.set(keyForm(value), { value, reason: 'place' });
  for (const value of publicFigures) names.set(keyForm(value), { value, reason: 'public figure' });
  for (const record of records) if ('table' in record) {
    for (const key of ['ciudad', 'pais', 'country']) {
      const value = record.columns[key];
      if (value && value.length < 80) names.set(keyForm(value), { value, reason: 'place' });
    }
    for (const key of ['banco', 'entidad_financiera', 'nombre_entidad', 'comercio', 'merchant', 'empresa']) {
      const value = record.columns[key];
      if (value && value.trim().length >= 3 && value.length < 100) names.set(keyForm(value), { value: value.trim(), reason: 'organization or merchant from source field' });
    }
  }
  const result: Entity[] = [];
  for (const { value, reason } of names.values()) {
    const ids = records.filter(record => strings(record).some(text => present(text, value))).map(record => record.id);
    if (ids.length) result.push({ entity_id: `k_${createHash('sha256').update(keyForm(value)).digest('hex').slice(0, 10)}`, type: 'organization_or_place', originals: [value], records: ids, kept: true, reason });
  }
  return result;
}
