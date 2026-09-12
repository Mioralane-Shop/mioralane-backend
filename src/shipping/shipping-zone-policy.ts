import { DeliveryZone } from '../order/order.model';

export type ShippingZoneAddress = {
  division?: string;
  district?: string;
  area?: string;
};

const normalizeComparable = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

// Mioralane V1 shipping business policy. These names are not official
// administrative or courier classifications.
export const DHAKA_SUBURBAN_AREAS = [
  'Dhamrai',
  'Dohar',
  'Keraniganj',
  'Nawabganj',
  'Savar',
] as const;

const DHAKA_SUBURBAN_AREA_SET = new Set(DHAKA_SUBURBAN_AREAS.map(normalizeComparable));

export const resolveShippingZone = ({ division, district, area }: ShippingZoneAddress): DeliveryZone => {
  const normalizedDivision = division ? normalizeComparable(division) : '';
  const normalizedDistrict = district ? normalizeComparable(district) : '';
  const normalizedArea = area ? normalizeComparable(area) : '';

  if (normalizedDivision !== 'dhaka' || normalizedDistrict !== 'dhaka') {
    return 'outside_dhaka';
  }

  if (DHAKA_SUBURBAN_AREA_SET.has(normalizedArea)) {
    return 'dhaka_suburban';
  }

  return 'inside_dhaka';
};
