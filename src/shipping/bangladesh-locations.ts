/**
 * Location lists used to resolve a delivery zone (P1.3, R2).
 *
 * ## Source
 *
 * The names are taken verbatim from the `bangladesh-geojson` dataset, which is
 * the same source the storefront builds its selects from
 * (`mioralane-frontend/src/constants/bangladesh-locations.ts` imports
 * `divisions`, `districts`, `upazilas` and `dhaka-city`). The inputs to
 * `resolveShippingZone` are the strings those selects submit
 * (`<SelectItem value={division.name}>`), so this file lists **exactly** the
 * values a customer can pick. It exists to refuse everything else, not to
 * second-guess the UI.
 *
 * That equality matters operationally: a district list that spells a name
 * differently from the dataset would reject a legitimate checkout. If the
 * dataset is ever upgraded, these lists must be regenerated in the same commit.
 *
 * ## Scope of what is validated
 *
 * - `division` and `district` are checked against the full national lists.
 * - `area` is checked **only for Dhaka district**, because only there does it
 *   change the price (`inside_dhaka` vs `dhaka_suburban`). For the other 63
 *   districts the area has no effect on the zone, and validating it would mean
 *   embedding ~495 upazila names for no pricing benefit — so a non-empty area is
 *   accepted there, exactly as before. That asymmetry is deliberate and is
 *   asserted in `tests/verify-order-tampering.ts`.
 */

/** Case- and whitespace-insensitive comparison key, shared with the zone policy. */
export const normalizeLocationName = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

/** The eight divisions of Bangladesh. */
export const BD_DIVISIONS: readonly string[] = [
  'Barishal',
  'Chattogram',
  'Dhaka',
  'Khulna',
  'Rajshahi',
  'Rangpur',
  'Sylhet',
  'Mymensingh',
];

/** All 64 districts, sorted by English name. */
export const BD_DISTRICTS: readonly string[] = [
  'Bagerhat',
  'Bandarban',
  'Barguna',
  'Barishal',
  'Bhola',
  'Bogura',
  'Brahmanbaria',
  'Chandpur',
  'Chattogram',
  'Chuadanga',
  "Cox's Bazar",
  'Cumilla',
  'Dhaka',
  'Dinajpur',
  'Faridpur',
  'Feni',
  'Gaibandha',
  'Gazipur',
  'Gopalganj',
  'Habiganj',
  'Jamalpur',
  'Jashore',
  'Jhalokati',
  'Jhenaidah',
  'Joypurhat',
  'Khagrachari',
  'Khulna',
  'Kishoreganj',
  'Kurigram',
  'Kushtia',
  'Lakshmipur',
  'Lalmonirhat',
  'Madaripur',
  'Magura',
  'Manikganj',
  'Maulvibazar',
  'Meherpur',
  'Munshiganj',
  'Mymensingh',
  'Naogaon',
  'Narail',
  'Narayanganj',
  'Narsingdi',
  'Natore',
  'Nawabganj',
  'Netrokona',
  'Nilphamari',
  'Noakhali',
  'Pabna',
  'Panchagarh',
  'Patuakhali',
  'Pirojpur',
  'Rajbari',
  'Rajshahi',
  'Rangamati',
  'Rangpur',
  'Satkhira',
  'Shariatpur',
  'Sherpur',
  'Sirajgonj',
  'Sunamganj',
  'Sylhet',
  'Tangail',
  'Thakurgaon',
];

/**
 * Dhaka district's upazilas — the only Dhaka addresses that are *not* priced as
 * city addresses.
 *
 * This is a Mioralane V1 business policy, not an official courier
 * classification, and it is checked **before** the city list below so the
 * overlap (`Dhamrai` and `Nawabganj` appear in both datasets) keeps its existing
 * meaning.
 */
export const DHAKA_SUBURBAN_AREAS: readonly string[] = [
  'Dhamrai',
  'Dohar',
  'Keraniganj',
  'Nawabganj',
  'Savar',
];

/**
 * Dhaka city areas (thanas / neighbourhoods / cantonment areas).
 *
 * 126 unique names — the dataset holds 142 rows, and both spellings that appear
 * for one place (for example `Nababganj`/`Nawabganj`, `Uttar Khan`/`Uttarkhan`,
 * `Basabo`/`Bashabo`) are kept, because the UI can submit either.
 */
export const DHAKA_CITY_AREAS: readonly string[] = [
  'Adabor', 'Agargaon', 'Airport', 'Armanitola', 'Badda', 'Badda Link Road',
  'Baily Road', 'Banani', 'Banasree Block-C', 'Banglamotor', 'Bangshal', 'Baridhara',
  'Basabo', 'Bashabo', 'Bashundhara', 'Bashundhara R/A', 'Basundhara R/A', 'Basundhara Residential Area',
  'Bijoynagar', 'Bongshal', 'Cantonment', 'Chawkbazar', 'Dakshinkhan', 'Darus Salam',
  'Darussalam', 'Demra', 'Dhaka Cantonment', 'Dhamrai', 'Dhanmondi', 'Dholpur',
  'Elephant Road', 'Fakirapool', 'Farmgate', 'Gabtoli', 'Gendaria', 'Green Road',
  'Gulshan', 'Gulshan Model Town', 'Hatirpool', 'Islampur', 'Jatrabari', 'Jhigatola',
  'Jurain', 'Kadamtoli', 'Kafrul', 'Kakrail', 'Kalabagan', 'Kamalapur',
  'Kamrangirchar', 'Kazipara', 'Khilgaon', 'Khilgaon Taltola', 'Khilkhet', 'Kotwali',
  'Kotwali Police Line', 'Kuril', 'Lalbagh', 'Lalmatia', 'Laxmibazar', 'Malibagh',
  'Malibagh Chowdhurypara', 'Malibagh Rail Gate', 'Merul Badda', 'Middle Badda', 'Mirpur', 'Mirpur Cantonment',
  'Mirpur DOHS', 'Mirpur-1', 'Mirpur-10', 'Mirpur-11', 'Mirpur-12', 'Mirpur-13',
  'Mirpur-14', 'Mirpur-2', 'Mirpur-6', 'Mirpur-7', 'Moghbazar', 'Mohakhali',
  'Mohakhali DOHS', 'Mohammadpur', 'Mohammadpur Housing', 'Mohammadpur Krishi Market', 'Monipur', 'Motijheel',
  'Mouchak', 'Nababganj', 'Nawabganj', 'Nayabazar', 'Nayatola', 'New Market',
  'Niketon', 'Nikunja', 'North Badda', 'Notun Bazar', 'Pallabi', 'Pallabi Extension',
  'Panthapath', 'Posta', 'Postogola', 'Rampura', 'Rampura Bazar', 'Rayer Bazar',
  'Rupnagar', 'Shah Ali', 'Shahbag', 'Shampur', 'Shantibagh', 'Shantibagh R/A',
  'Shantinagar', 'Sher-e-Bangla Nagar', 'Shewrapara', 'Shyamoli', 'Shyampur', 'Siddheshwari',
  'South Mugda', 'Sutrapur', 'Tanti Bazar', 'Tejgaon', 'Tikatuli', 'Tongi',
  'Uttar Khan', 'Uttara', 'Uttarkhan', 'Vatara', 'Wari', 'Zigatola',
];

/** The district whose area list decides between the two Dhaka zones. */
export const DHAKA_DISTRICT = 'dhaka';

const toNormalizedSet = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.map(normalizeLocationName));

export const BD_DIVISION_SET = toNormalizedSet(BD_DIVISIONS);
export const BD_DISTRICT_SET = toNormalizedSet(BD_DISTRICTS);
export const DHAKA_CITY_AREA_SET = toNormalizedSet(DHAKA_CITY_AREAS);
export const DHAKA_SUBURBAN_AREA_SET = toNormalizedSet(DHAKA_SUBURBAN_AREAS);

/** True when `value` is one of the eight division names. */
export const isKnownDivision = (value: string): boolean =>
  BD_DIVISION_SET.has(normalizeLocationName(value));

/** True when `value` is one of the 64 district names. */
export const isKnownDistrict = (value: string): boolean =>
  BD_DISTRICT_SET.has(normalizeLocationName(value));

/** True when `value` is a Dhaka city area or a Dhaka suburban upazila. */
export const isKnownDhakaArea = (value: string): boolean => {
  const normalized = normalizeLocationName(value);

  return DHAKA_CITY_AREA_SET.has(normalized) || DHAKA_SUBURBAN_AREA_SET.has(normalized);
};
