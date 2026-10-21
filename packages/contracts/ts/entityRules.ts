import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { packageRoot } from './contractVersion.js';

/** One kind of entity, as entity_rules.json defines it (EPOCH-581). */
export interface EntityKind {
  kind: string;
  /** What the kind is called where an examiner reads it. */
  title: string;
}

/**
 * The kinds of entity, in the rules' order, read from entity_rules.json: the
 * one file the entities stage (Python) reads too, so a kind is named once (R2).
 */
export function entityKinds(): EntityKind[] {
  const file = path.join(packageRoot(), 'entity_rules.json');
  const rules = JSON.parse(readFileSync(file, 'utf8')) as { kinds?: Record<string, { title?: unknown }> };
  return Object.entries(rules.kinds ?? {}).map(([kind, definition]) => {
    if (typeof definition.title !== 'string' || !definition.title.trim()) {
      throw new Error(`entity_rules.json: kind ${kind} has no title`);
    }
    return { kind, title: definition.title };
  });
}

/** What each shape hint is called (entity_rules.json `shape_hints`): shapes that rank an unclassified field for review. */
export function entityShapeHints(): Record<string, string> {
  const file = path.join(packageRoot(), 'entity_rules.json');
  const rules = JSON.parse(readFileSync(file, 'utf8')) as { shape_hints?: Record<string, unknown> };
  return Object.fromEntries(
    Object.entries(rules.shape_hints ?? {}).map(([hint, title]) => {
      if (typeof title !== 'string' || !title.trim())
        throw new Error(`entity_rules.json: shape hint ${hint} has no title`);
      return [hint, title];
    })
  );
}
