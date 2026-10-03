import { DeliveryZone } from '../order/order.model';
import {
  DHAKA_CITY_AREA_SET,
  DHAKA_DISTRICT,
  DHAKA_SUBURBAN_AREA_SET,
  isKnownDistrict,
  isKnownDivision,
  normalizeLocationName,
} from './bangladesh-locations';

export type ShippingZoneAddress = {
  division?: string;
  district?: string;
  area?: string;
};

/**
 * Error shape the callers already read (`shipping.service.ts` and every
 * controller). Declared here rather than imported from `shipping.service`,
 * because that module imports this one — a cycle for a three-line helper.
 */
type ShippingZoneError = Error & { statusCode: number; code: string };

const createZoneError = (message: string, code: string): ShippingZoneError => {
  const error = new Error(message) as ShippingZoneError;
  error.statusCode = 400;
  error.code = code;

  return error;
};

/** Re-exported: the suburban list is a pricing policy, and it lives with the rest of the data. */
export { DHAKA_SUBURBAN_AREAS } from './bangladesh-locations';

/**
 * Resolves the delivery zone from the address, failing closed (P1.3, R2).
 *
 * ## What changed, and why
 *
 * The previous version ended in `return 'inside_dhaka'` for every address whose
 * division and district both normalized to `dhaka` — so *any* unmatched area
 * string, including a made-up one or a genuinely outside-Dhaka address that
 * merely claimed `district: "Dhaka"`, was charged the cheapest zone. The fee
 * itself was always read from server-side settings, but the *classification*
 * trusted three free-text strings and defaulted to the cheapest one.
 *
 * Now the district must be one of the 64 known districts, and a Dhaka address
 * must name a known area. Anything else is a 400 the customer can act on instead
 * of a silent discount.
 *
 * Ordering is preserved deliberately: the suburban list is checked **before** the
 * city list, so the names present in both datasets (`Dhamrai`, `Nawabganj`) keep
 * the meaning they have always had.
 *
 * Scope note: `area` is validated only for Dhaka district, where it decides the
 * price. For the other 63 districts it cannot change the zone, so a non-empty
 * area is accepted — the reasoning is in `bangladesh-locations.ts`.
 */
export const resolveShippingZone = ({ division, district, area }: ShippingZoneAddress): DeliveryZone => {
  const normalizedDivision = division ? normalizeLocationName(division) : '';
  const normalizedDistrict = district ? normalizeLocationName(district) : '';
  const normalizedArea = area ? normalizeLocationName(area) : '';

  // Fixed wording, never an echo of the submitted value.
  if (!isKnownDivision(normalizedDivision)) {
    throw createZoneError(
      'Delivery division is not recognised. Please choose one from the list.',
      'unknown_delivery_division'
    );
  }

  if (!isKnownDistrict(normalizedDistrict)) {
    throw createZoneError(
      'Delivery district is not recognised. Please choose one from the list.',
      'unknown_delivery_district'
    );
  }

  if (normalizedDistrict !== DHAKA_DISTRICT) {
    return 'outside_dhaka';
  }

  if (DHAKA_SUBURBAN_AREA_SET.has(normalizedArea)) {
    return 'dhaka_suburban';
  }

  if (DHAKA_CITY_AREA_SET.has(normalizedArea)) {
    return 'inside_dhaka';
  }

  throw createZoneError(
    'Delivery area is not recognised for Dhaka. Please choose one from the list.',
    'unknown_delivery_area'
  );
};
