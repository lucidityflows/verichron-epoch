import { describe, expect, it } from 'vitest';

import { shownModel } from './deviceModel';

describe('shownModel', () => {
  it('puts a space between the device family and its model number', () => {
    expect(shownModel('iPhone17,5')).toBe('iPhone 17,5');
    expect(shownModel('iPad13,1')).toBe('iPad 13,1');
  });

  it('leaves a name that is not a product type as it is', () => {
    expect(shownModel('iPhone 17,5')).toBe('iPhone 17,5');
    expect(shownModel('backup-2026-10-15')).toBe('backup-2026-10-15');
  });
});
