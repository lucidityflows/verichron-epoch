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
  it('tints a secondary button in the accent, never the surface colour', () => {
    render(<Button variant="outline">Change Destination</Button>);
    const classes = classesOf('Change Destination');
    assert.ok(classes.includes('bg-accent/15'));
    assert.ok(classes.includes('text-accent'));
    assert.ok(!classes.includes('bg-surface-raised'));
  });

  it('tints a destructive secondary button in the danger colour, with foreground text', () => {
    render(
      <Button variant="outline" tone="danger">
        Delete It
      </Button>
    );
    const classes = classesOf('Delete It');
    assert.ok(classes.includes('bg-danger/15'));
    assert.ok(classes.includes('text-foreground'));
    assert.ok(!classes.includes('bg-accent/15'), 'the danger tint replaces the accent one');
    assert.ok(!classes.includes('text-accent'));
  });

  it('keeps the primary button a filled accent', () => {
    render(<Button>Pull Encrypted Backup</Button>);
    assert.ok(classesOf('Pull Encrypted Backup').includes('bg-accent'));
  });
});
