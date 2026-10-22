import { describe, expect, it } from 'vitest';
import { emptyPricing, pricedBackendIds, togglePricing } from './storage-pricing';

describe('storage pricing', () => {
  it('lists the configured backends, then the priced ones that are not configured any more', () => {
    expect(pricedBackendIds(['originals', 'derived'], [emptyPricing('old'), emptyPricing('originals')])).toEqual([
      'originals',
      'derived',
      'old',
    ]);
  });

  it('adds the prices of a backend in the currency of the others, and removes them', () => {
    const prices = [emptyPricing('originals', 'USD')];

    const added = togglePricing(prices, 'derived', true);
    expect(added).toEqual([emptyPricing('originals', 'USD'), emptyPricing('derived', 'USD')]);
    expect(added[1].monthlyBudget).toBeNull();

    expect(togglePricing(added, 'originals', false)).toEqual([emptyPricing('derived', 'USD')]);
  });
});
