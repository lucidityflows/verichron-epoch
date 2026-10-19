/**
 * EPOCH-506: a secondary button is tinted, so it reads as a button on every
 * surface tier; a destructive one is tinted in the danger colour with
 * foreground text (DESIGN.md §9).
 */

import assert from 'node:assert/strict';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { Button } from './Button';

afterEach(cleanup);

const classesOf = (name: string) => screen.getByRole('button', { name }).className.split(/\s+/);

describe('Button', () => {
  it('keeps a secondary button neutral, with a border, so only the primary action is coloured (EPOCH-574)', () => {
    render(<Button variant="outline">Change Destination</Button>);
    const classes = classesOf('Change Destination');
    assert.ok(classes.includes('bg-surface-raised'));
    assert.ok(classes.includes('text-foreground'));
    assert.ok(classes.includes('border-border-strong'));
    assert.ok(!classes.includes('text-accent') && !classes.includes('bg-accent/15'), 'no accent on a secondary');
  });

  it('marks a destructive secondary button in the danger colour, on the neutral button', () => {
    render(
      <Button variant="outline" tone="danger">
        Delete It
      </Button>
    );
    const classes = classesOf('Delete It');
    assert.ok(classes.includes('text-danger'));
    assert.ok(classes.includes('border-danger/60'));
    assert.ok(!classes.includes('text-foreground'), 'the danger text replaces the neutral one');
  });

  it('keeps the primary button a filled accent', () => {
    render(<Button>Pull Encrypted Backup</Button>);
    assert.ok(classesOf('Pull Encrypted Backup').includes('bg-accent'));
  });
});
