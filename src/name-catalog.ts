import { createHash } from 'node:crypto';

// Local, reviewable name catalogs. A language cue is not treated as nationality.
const firstFemale = ['Valentina', 'Camila', 'Daniela', 'Mariana', 'Natalia', 'Paula', 'Laura', 'Carolina', 'Andrea', 'Juliana', 'Alejandra', 'Catalina', 'Lucía', 'Isabella', 'Sofía', 'Gabriela', 'Sara', 'Manuela', 'María', 'Ana', 'Lina', 'Diana', 'Adriana', 'Claudia', 'Tatiana', 'Angélica', 'Marcela', 'Paola', 'Mónica', 'Sandra', 'Patricia', 'Eliana', 'Lorena', 'Liliana', 'Fernanda', 'Viviana', 'Johana', 'Ingrid', 'Rocío', 'Margarita'];
const firstMale = ['Santiago', 'Andrés', 'Mateo', 'Sebastián', 'Nicolás', 'Julián', 'Felipe', 'Daniel', 'Juan', 'David', 'Miguel', 'Esteban', 'Alejandro', 'Carlos', 'Jorge', 'José', 'Luis', 'Manuel', 'Diego', 'Mauricio', 'Ricardo', 'Óscar', 'Fernando', 'Camilo', 'Cristian', 'Jonathan', 'Javier', 'Hernán', 'Álvaro', 'Edwin', 'Wilson', 'Anderson', 'Brayan', 'Kevin', 'Leonardo', 'William', 'Sergio', 'Pablo', 'Tomás', 'Emilio'];
const firstNeutral = ['Alex', 'Dani', 'Sam', 'Ariel', 'René', 'Cruz', 'Guadalupe', 'Noel', 'Eli'];
const surnames = ['Rojas', 'Morales', 'Castro', 'Vargas', 'Cárdenas', 'Pineda', 'Sánchez', 'Herrera', 'Mendoza', 'Torres', 'Suárez', 'Ramírez', 'Gómez', 'Valencia', 'Salazar', 'Ortiz', 'Rodríguez', 'Martínez', 'García', 'López', 'Pérez', 'González', 'Hernández', 'Díaz', 'Muñoz', 'Jiménez', 'Romero', 'Navarro', 'Acosta', 'Bermúdez', 'Quintero', 'Hurtado', 'Montoya', 'Restrepo', 'Ospina', 'Castaño', 'Arias', 'Mejía', 'Arango', 'Velásquez', 'Cardona', 'Giraldo', 'Henao', 'Franco', 'Mora', 'Soto', 'Pardo', 'Peña', 'Rincón', 'Buitrago', 'Molina', 'Córdoba', 'Guerrero', 'Delgado', 'Cortés', 'Reyes', 'Parra', 'Medina', 'Ruiz', 'Ríos'];
const englishFemale = ['Emily', 'Charlotte', 'Olivia', 'Amelia', 'Grace', 'Hannah', 'Sophie', 'Lucy', 'Alice', 'Emma', 'Sarah', 'Megan', 'Chloe', 'Jessica', 'Abigail', 'Eleanor'];
const englishMale = ['James', 'Oliver', 'William', 'Thomas', 'George', 'Henry', 'Jack', 'Noah', 'Liam', 'Ethan', 'Lucas', 'Benjamin', 'Alexander', 'Samuel', 'Daniel', 'Matthew', 'Peter', 'John', 'Michael', 'Robert', 'Edward', 'Charles'];
const englishNeutral = ['Alex', 'Taylor', 'Jordan', 'Morgan', 'Casey', 'Jamie', 'Sam', 'Avery'];
const englishSurnames = ['Smith', 'Johnson', 'Brown', 'Wilson', 'Taylor', 'Martin', 'Clark', 'Walker', 'Harris', 'Lewis', 'Robinson', 'Allen', 'Hall', 'Young', 'King', 'Scott'];
const regional = {
  'es-MX': { female: ['Ximena', 'Regina', 'Fernanda', 'Montserrat'], male: ['Emiliano', 'Gael', 'Rodrigo', 'Joaquín'], surnames: ['Hernández', 'García', 'Martínez', 'López', 'Sánchez', 'Flores'] },
  'en-US': { female: ['Ava', 'Harper', 'Madison', 'Mia'], male: ['Mason', 'Logan', 'Jackson', 'Aiden'], surnames: ['Miller', 'Davis', 'Anderson', 'Thomas', 'Moore', 'Jackson'] },
  'en-GB': { female: ['Poppy', 'Freya', 'Isla', 'Ruby'], male: ['Freddie', 'Alfie', 'Archie', 'Arthur'], surnames: ['Jones', 'Williams', 'Davies', 'Evans', 'Thomas', 'Roberts'] },
  'en-AU': { female: ['Matilda', 'Isla', 'Sienna', 'Zoe'], male: ['Cooper', 'Hudson', 'Lachlan', 'Levi'], surnames: ['Nguyen', 'Williams', 'Brown', 'Wilson', 'Taylor', 'White'] },
} as const;
type NameContext = 'es' | 'es-MX' | 'en' | 'en-US' | 'en-GB' | 'en-AU';

export function keyForm(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function seed(value: string): number { return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16); }
export function kindFromName(name: string): 'female' | 'male' | 'unknown' {
  const first = keyForm(name).split(' ')[0];
  if (firstFemale.some(n => keyForm(n) === first)) return 'female';
  if (firstMale.some(n => keyForm(n) === first)) return 'male';
  if (englishFemale.some(n => keyForm(n) === first)) return 'female';
  if (englishMale.some(n => keyForm(n) === first)) return 'male';
  for (const region of Object.values(regional)) {
    if (region.female.some(n => keyForm(n) === first)) return 'female';
    if (region.male.some(n => keyForm(n) === first)) return 'male';
  }
  return 'unknown';
}
export function nameContext(name: string, explicit?: string): NameContext {
  const country = keyForm(explicit ?? '');
  if (['estados unidos', 'united states', 'usa', 'us'].includes(country)) return 'en-US';
  if (['reino unido', 'united kingdom', 'uk', 'england', 'inglaterra'].includes(country)) return 'en-GB';
  if (['australia', 'au'].includes(country)) return 'en-AU';
  if (['méxico', 'mexico', 'mx'].includes(country)) return 'es-MX';
  if (['colombia', 'españa', 'spain'].includes(country)) return 'es';
  const first = keyForm(name).split(' ')[0];
  if ([...englishFemale, ...englishMale, ...englishNeutral, ...regional['en-US'].female, ...regional['en-US'].male, ...regional['en-GB'].female, ...regional['en-GB'].male, ...regional['en-AU'].female, ...regional['en-AU'].male].some(n => keyForm(n) === first) && ![...firstFemale, ...firstMale, ...firstNeutral].some(n => keyForm(n) === first)) return 'en';
  return 'es';
}
export function newName(key: string, gender: 'female' | 'male' | 'unknown', context: NameContext, attempt: number): string {
  const english = context.startsWith('en');
  const region = context in regional ? regional[context as keyof typeof regional] : undefined;
  const list = gender === 'unknown' ? english ? englishNeutral : firstNeutral : region ? gender === 'female' ? [...region.female, ...(english ? englishFemale : firstFemale)] : [...region.male, ...(english ? englishMale : firstMale)] : english ? gender === 'female' ? englishFemale : englishMale : gender === 'female' ? firstFemale : firstMale;
  const family = region ? [...region.surnames, ...(english ? englishSurnames : surnames)] : english ? englishSurnames : surnames;
  const index = seed(`${key}:${attempt}`);
  const first = list[index % list.length];
  const last = family[Math.floor(index / list.length) % family.length];
  const last2 = family[Math.floor(index / (list.length * family.length)) % family.length];
  return english ? `${first} ${last}` : `${first} ${last} ${last2}`;
}
