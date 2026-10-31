import { keyForm } from './name-catalog.js';
import type { TableRecord } from './types.js';

export type IndirectPlan = { occupation?: { original: string; replacement: string }; neighborhood?: { original: string; replacement: string }; neighborhoodContext?: string };
function category(value: string): string {
  const text = keyForm(value);
  if (/contador|audit|finanz|banc|administr/.test(text)) return 'sector administrativo';
  if (/periodis|comunic|redact|medios/.test(text)) return 'profesional de medios';
  if (/medic|enferm|salud|odont|psicolog/.test(text)) return 'sector salud';
  if (/profesor|docen|maestr|educ/.test(text)) return 'sector educativo';
  if (/ingenier|desarroll|program|tecnolog/.test(text)) return 'sector tecnológico';
  if (/comerc|vent|tienda|mercad/.test(text)) return 'sector comercial';
  if (/construc|electric|mecanic|tecnic/.test(text)) return 'oficio técnico';
  if (/conduc|transport|logistic|taxi/.test(text)) return 'sector transporte';
  if (/agric|ganad|cultiv|campes/.test(text)) return 'sector agropecuario';
  if (/artis|musico|actor|disen|fotograf/.test(text)) return 'sector creativo';
  if (/cocin|restaur|chef|meser|hotel/.test(text)) return 'sector servicios';
  if (/abog|jurid|derecho/.test(text)) return 'sector jurídico';
  return 'actividad laboral';
}

export function planIndirect(rows: TableRecord[]): Map<string, IndirectPlan> {
  const clients = rows.filter(row => row.table === 'clientes');
  const count = new Map<string, number>();
  const countBroad = new Map<string, number>();
  const countArea = new Map<string, number>();
  const tuple = (parts: string[]) => parts.map(keyForm).join('\u0000');
  for (const row of clients) {
    const c = row.columns;
    for (const [map, key] of [
      [count, tuple([c.ciudad ?? '', c.barrio ?? '', c.ocupacion ?? ''])],
      [countBroad, tuple([c.ciudad ?? '', c.barrio ?? '', category(c.ocupacion ?? '')])],
      [countArea, tuple([c.ciudad ?? '', c.barrio ?? ''])],
    ] as const) map.set(key, (map.get(key) ?? 0) + 1);
  }
  const plans = new Map<string, IndirectPlan>();
  for (const row of clients) {
    const c = row.columns; const plan: IndirectPlan = {};
    const detailed = tuple([c.ciudad ?? '', c.barrio ?? '', c.ocupacion ?? '']);
    if (c.ocupacion && count.get(detailed) === 1) {
      const broad = category(c.ocupacion);
      plan.occupation = { original: c.ocupacion, replacement: (countBroad.get(tuple([c.ciudad ?? '', c.barrio ?? '', broad])) ?? 0) > 1 ? broad : 'actividad laboral' };
      plan.neighborhoodContext = c.barrio;
    }
    if (c.barrio && countArea.get(tuple([c.ciudad ?? '', c.barrio ?? ''])) === 1) plan.neighborhood = { original: c.barrio, replacement: 'sector de la ciudad' };
    if (plan.occupation || plan.neighborhood) plans.set(c.cliente_id, plan);
  }
  return plans;
}
