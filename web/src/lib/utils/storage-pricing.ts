import type { AdminConfigStorageBackendPricingDto } from '@immich/sdk';

/** The prices of a backend before they are filled in */
export const emptyPricing = (backendId: string, currency = 'CNY'): AdminConfigStorageBackendPricingDto => ({
  backendId,
  currency,
  storageGbMonth: 0,
  writeRequests10k: 0,
  readRequests10k: 0,
  deleteRequests10k: 0,
  egressGb: 0,
  monthlyBudget: null,
});

/**
 * The backends to show prices for: the configured ones, then those that have prices but are no longer configured (so
 * that their prices can be removed)
 */
export const pricedBackendIds = (configured: string[], pricings: AdminConfigStorageBackendPricingDto[]) => [
  ...configured,
  ...pricings.map(({ backendId }) => backendId).filter((id) => !configured.includes(id)),
];

/** The prices with those of a backend added (with the currency of the others) or removed */
export const togglePricing = (
  pricings: AdminConfigStorageBackendPricingDto[],
  backendId: string,
  enabled: boolean,
): AdminConfigStorageBackendPricingDto[] => {
  const others = pricings.filter((pricing) => pricing.backendId !== backendId);
  return enabled ? [...others, emptyPricing(backendId, pricings[0]?.currency)] : others;
};
