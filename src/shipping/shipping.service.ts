import mongoose from 'mongoose';
import crypto from 'crypto';
import { DeliveryZone } from '../order/order.model';
import {
  DEFAULT_SHIPPING_SETTINGS,
  IShippingSettingsDocument,
  ShippingSettings,
  ShippingSettingsValue,
} from './shipping-settings.model';
import { resolveShippingZone } from './shipping-zone-policy';

type HttpError = Error & { statusCode?: number; code?: string };
export const SHIPPING_ZONES: DeliveryZone[] = ['inside_dhaka', 'dhaka_suburban', 'outside_dhaka'];

export type ShippingAddressInput = {
  name?: string;
  phone?: string;
  division?: string;
  district?: string;
  area?: string;
  thana?: string;
  address?: string;
  detailedAddress?: string;
  landmark?: string;
  deliveryZone?: DeliveryZone;
};

export type NormalizedShippingAddress = {
  name: string;
  phone: string;
  division: string;
  district: string;
  area: string;
  address: string;
  landmark?: string;
  deliveryZone: DeliveryZone;
};

export type NormalizedShippingQuoteAddress = {
  division: string;
  district: string;
  area: string;
  deliveryZone: DeliveryZone;
};

export type ShippingResolution = {
  zone: DeliveryZone;
  baseCharge: number;
  finalCharge: number;
  isFreeDelivery: boolean;
  freeDeliveryReason?: 'threshold' | 'campaign';
  estimatedMinDays: number;
  estimatedMaxDays: number;
  availability: {
    available: boolean;
    message?: string;
  };
};

export type CheckoutQuoteFingerprintInput = {
  shipping: ShippingResolution;
  totals: {
    subtotal: number;
    discountAmount: number;
    shippingFee: number;
    totalAmount: number;
  };
  promotion?: {
    campaignId?: unknown;
    campaignName?: string;
    campaignType?: string;
  };
  coupon?: {
    couponId?: unknown;
    code?: string;
    discountType?: string;
    discountValue?: number;
    discountAmount?: number;
  };
};

export type ResolveShippingInput = {
  address: ShippingAddressInput;
  itemsTotal: number;
  discountAmount: number;
  promotionFreeDelivery?: boolean;
  session?: mongoose.ClientSession;
};

export type ApplyShippingChargeRulesInput = {
  baseCharge: number;
  itemsTotal: number;
  discountAmount: number;
  threshold: {
    enabled: boolean;
    minimumOrderValue: number;
  };
  promotionFreeDelivery?: boolean;
};

export const createShippingError = (
  statusCode: number,
  message: string,
  code?: string
): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const normalizeRequiredField = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeOptionalField = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isValidPhone = (value: string): boolean => /^[0-9+\-\s()]+$/.test(value);

export const resolveDeliveryZone = (
  address: Pick<ShippingAddressInput, 'division' | 'district' | 'area' | 'thana'>
): DeliveryZone => {
  const division = normalizeRequiredField(address.division);
  const district = normalizeRequiredField(address.district);
  const area = normalizeRequiredField(address.area ?? address.thana);

  if (!division || !district || !area) {
    throw createShippingError(400, 'Division, district, and area/thana are required', 'invalid_shipping_zone_address');
  }

  return resolveShippingZone({ division, district, area });
};

export const validateAndNormalizeShippingAddress = (
  input: ShippingAddressInput | undefined
): NormalizedShippingAddress => {
  const name = normalizeRequiredField(input?.name);
  const phone = normalizeRequiredField(input?.phone);
  const division = normalizeRequiredField(input?.division);
  const district = normalizeRequiredField(input?.district);
  const area = normalizeRequiredField(input?.area ?? input?.thana);
  const address = normalizeRequiredField(input?.detailedAddress ?? input?.address);
  const landmark = normalizeOptionalField(input?.landmark);

  if (!name || !phone || !division || !district || !area || !address) {
    throw createShippingError(
      400,
      'Shipping name, phone, division, district, area/thana, and detailed address are required',
      'invalid_shipping_address'
    );
  }

  if (!isValidPhone(phone)) {
    throw createShippingError(400, 'Phone number contains invalid characters', 'invalid_phone');
  }

  return {
    name,
    phone: phone.replace(/\s+/g, ' '),
    division,
    district,
    area,
    address,
    landmark,
    deliveryZone: resolveDeliveryZone({ division, district, area }),
  };
};

export const validateAndNormalizeShippingQuoteAddress = (
  input: ShippingAddressInput | undefined
): NormalizedShippingQuoteAddress => {
  const division = normalizeRequiredField(input?.division);
  const district = normalizeRequiredField(input?.district);
  const area = normalizeRequiredField(input?.area ?? input?.thana);

  if (!division || !district || !area) {
    throw createShippingError(
      400,
      'Division, district, and area/thana are required',
      'invalid_shipping_quote_address'
    );
  }

  return {
    division,
    district,
    area,
    deliveryZone: resolveDeliveryZone({ division, district, area }),
  };
};

export const validateShippingSettingsPayload = (payload: ShippingSettingsValue): void => {
  for (const zone of SHIPPING_ZONES) {
    const settings = payload.zones[zone];
    if (!settings || settings.charge < 0 || settings.estimatedMinDays < 0 || settings.estimatedMaxDays < 0) {
      throw createShippingError(400, 'Shipping charges and estimated days must be zero or greater', 'invalid_shipping_settings');
    }

    if (settings.estimatedMinDays > settings.estimatedMaxDays) {
      throw createShippingError(400, 'Estimated minimum days must be less than or equal to maximum days', 'invalid_estimated_days');
    }
  }

  if (
    payload.freeDeliveryThreshold.enabled &&
    payload.freeDeliveryThreshold.minimumOrderValue < 0
  ) {
    throw createShippingError(400, 'Free delivery minimum order value must be zero or greater', 'invalid_free_delivery_threshold');
  }
};

export const applyShippingChargeRules = ({
  baseCharge,
  itemsTotal,
  discountAmount,
  threshold,
  promotionFreeDelivery = false,
}: ApplyShippingChargeRulesInput): Pick<ShippingResolution, 'finalCharge' | 'isFreeDelivery' | 'freeDeliveryReason'> => {
  const shippingEligibilitySubtotal = Math.max(0, itemsTotal - discountAmount);
  const thresholdFreeDelivery =
    threshold.enabled && shippingEligibilitySubtotal >= threshold.minimumOrderValue;
  const isFreeDelivery = thresholdFreeDelivery || promotionFreeDelivery;

  return {
    finalCharge: isFreeDelivery ? 0 : baseCharge,
    isFreeDelivery,
    freeDeliveryReason: promotionFreeDelivery ? 'campaign' : thresholdFreeDelivery ? 'threshold' : undefined,
  };
};

const normalizeZoneSettingsPayload = (value: any, fallback: ShippingSettingsValue['zones'][DeliveryZone]) => ({
  enabled: value?.enabled ?? fallback.enabled,
  charge: Number(value?.charge ?? fallback.charge),
  estimatedMinDays: Number(value?.estimatedMinDays ?? fallback.estimatedMinDays),
  estimatedMaxDays: Number(value?.estimatedMaxDays ?? fallback.estimatedMaxDays),
});

export const normalizeShippingSettingsPayload = (body: any): ShippingSettingsValue => {
  const settings: ShippingSettingsValue = {
    singletonKey: 'shipping_settings',
    zones: {
      inside_dhaka: normalizeZoneSettingsPayload(body?.zones?.inside_dhaka, DEFAULT_SHIPPING_SETTINGS.zones.inside_dhaka),
      dhaka_suburban: normalizeZoneSettingsPayload(body?.zones?.dhaka_suburban, DEFAULT_SHIPPING_SETTINGS.zones.dhaka_suburban),
      outside_dhaka: normalizeZoneSettingsPayload(body?.zones?.outside_dhaka, DEFAULT_SHIPPING_SETTINGS.zones.outside_dhaka),
    },
    freeDeliveryThreshold: {
      enabled: Boolean(body?.freeDeliveryThreshold?.enabled),
      minimumOrderValue: Number(body?.freeDeliveryThreshold?.minimumOrderValue),
    },
    addressRequirements: {
      landmarkRequired: Boolean(body?.addressRequirements?.landmarkRequired),
    },
  };

  if (
    !Number.isFinite(settings.zones.inside_dhaka.charge) ||
    !Number.isFinite(settings.zones.inside_dhaka.estimatedMinDays) ||
    !Number.isFinite(settings.zones.inside_dhaka.estimatedMaxDays) ||
    !Number.isFinite(settings.zones.dhaka_suburban.charge) ||
    !Number.isFinite(settings.zones.dhaka_suburban.estimatedMinDays) ||
    !Number.isFinite(settings.zones.dhaka_suburban.estimatedMaxDays) ||
    !Number.isFinite(settings.zones.outside_dhaka.charge) ||
    !Number.isFinite(settings.zones.outside_dhaka.estimatedMinDays) ||
    !Number.isFinite(settings.zones.outside_dhaka.estimatedMaxDays) ||
    !Number.isFinite(settings.freeDeliveryThreshold.minimumOrderValue)
  ) {
    throw createShippingError(400, 'Shipping settings contain invalid numeric values', 'invalid_shipping_settings');
  }

  validateShippingSettingsPayload(settings);
  return settings;
};

export const serializeShippingSettings = (
  settings: IShippingSettingsDocument | ShippingSettingsValue
): ShippingSettingsValue => ({
  singletonKey: 'shipping_settings',
  zones: {
    inside_dhaka: {
      enabled: Boolean(settings.zones?.inside_dhaka?.enabled ?? DEFAULT_SHIPPING_SETTINGS.zones.inside_dhaka.enabled),
      charge: Number(settings.zones?.inside_dhaka?.charge ?? DEFAULT_SHIPPING_SETTINGS.zones.inside_dhaka.charge),
      estimatedMinDays: Number(settings.zones?.inside_dhaka?.estimatedMinDays ?? DEFAULT_SHIPPING_SETTINGS.zones.inside_dhaka.estimatedMinDays),
      estimatedMaxDays: Number(settings.zones?.inside_dhaka?.estimatedMaxDays ?? DEFAULT_SHIPPING_SETTINGS.zones.inside_dhaka.estimatedMaxDays),
    },
    dhaka_suburban: {
      enabled: Boolean(settings.zones?.dhaka_suburban?.enabled ?? DEFAULT_SHIPPING_SETTINGS.zones.dhaka_suburban.enabled),
      charge: Number(settings.zones?.dhaka_suburban?.charge ?? DEFAULT_SHIPPING_SETTINGS.zones.dhaka_suburban.charge),
      estimatedMinDays: Number(settings.zones?.dhaka_suburban?.estimatedMinDays ?? DEFAULT_SHIPPING_SETTINGS.zones.dhaka_suburban.estimatedMinDays),
      estimatedMaxDays: Number(settings.zones?.dhaka_suburban?.estimatedMaxDays ?? DEFAULT_SHIPPING_SETTINGS.zones.dhaka_suburban.estimatedMaxDays),
    },
    outside_dhaka: {
      enabled: Boolean(settings.zones?.outside_dhaka?.enabled ?? DEFAULT_SHIPPING_SETTINGS.zones.outside_dhaka.enabled),
      charge: Number(settings.zones?.outside_dhaka?.charge ?? DEFAULT_SHIPPING_SETTINGS.zones.outside_dhaka.charge),
      estimatedMinDays: Number(settings.zones?.outside_dhaka?.estimatedMinDays ?? DEFAULT_SHIPPING_SETTINGS.zones.outside_dhaka.estimatedMinDays),
      estimatedMaxDays: Number(settings.zones?.outside_dhaka?.estimatedMaxDays ?? DEFAULT_SHIPPING_SETTINGS.zones.outside_dhaka.estimatedMaxDays),
    },
  },
  freeDeliveryThreshold: {
    enabled: Boolean(settings.freeDeliveryThreshold.enabled),
    minimumOrderValue: Number(settings.freeDeliveryThreshold.minimumOrderValue),
  },
  addressRequirements: {
    landmarkRequired: Boolean(settings.addressRequirements?.landmarkRequired ?? DEFAULT_SHIPPING_SETTINGS.addressRequirements.landmarkRequired),
  },
});

export const createCheckoutQuoteFingerprint = ({
  shipping,
  totals,
  promotion,
  coupon,
}: CheckoutQuoteFingerprintInput): string => {
  const fingerprintState = {
    shipping: {
      zone: shipping.zone,
      baseCharge: shipping.baseCharge,
      finalCharge: shipping.finalCharge,
      isFreeDelivery: shipping.isFreeDelivery,
      freeDeliveryReason: shipping.freeDeliveryReason ?? null,
      estimatedMinDays: shipping.estimatedMinDays,
      estimatedMaxDays: shipping.estimatedMaxDays,
      available: shipping.availability.available,
    },
    totals,
    promotion: promotion
      ? {
          campaignId: promotion.campaignId?.toString?.() ?? null,
          campaignName: promotion.campaignName ?? null,
          campaignType: promotion.campaignType ?? null,
        }
      : null,
    coupon: coupon
      ? {
          couponId: coupon.couponId?.toString?.() ?? null,
          code: coupon.code ?? null,
          discountType: coupon.discountType ?? null,
          discountValue: coupon.discountValue ?? null,
          discountAmount: coupon.discountAmount ?? null,
        }
      : null,
  };

  return crypto.createHash('sha256').update(JSON.stringify(fingerprintState)).digest('hex');
};

export const getShippingSettings = async (
  session?: mongoose.ClientSession
): Promise<ShippingSettingsValue> => {
  const settings = await ShippingSettings.findOne({ singletonKey: 'shipping_settings' })
    .session(session ?? null)
    .exec();

  return settings ? serializeShippingSettings(settings) : DEFAULT_SHIPPING_SETTINGS;
};

export const upsertShippingSettings = async (body: any): Promise<ShippingSettingsValue> => {
  const normalized = normalizeShippingSettingsPayload(body);
  const settings = await ShippingSettings.findOneAndUpdate(
    { singletonKey: 'shipping_settings' },
    normalized,
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).exec();

  return serializeShippingSettings(settings);
};

export const resolveShipping = async ({
  address,
  itemsTotal,
  discountAmount,
  promotionFreeDelivery = false,
  session,
}: ResolveShippingInput): Promise<ShippingResolution & { normalizedAddress: NormalizedShippingAddress }> => {
  const normalizedAddress = validateAndNormalizeShippingAddress(address);
  const settings = await getShippingSettings(session);
  const zoneSettings = settings.zones[normalizedAddress.deliveryZone];

  if (!zoneSettings.enabled) {
    return {
      normalizedAddress,
      zone: normalizedAddress.deliveryZone,
      baseCharge: zoneSettings.charge,
      finalCharge: 0,
      isFreeDelivery: false,
      estimatedMinDays: zoneSettings.estimatedMinDays,
      estimatedMaxDays: zoneSettings.estimatedMaxDays,
      availability: {
        available: false,
        message: 'Delivery is currently unavailable for the selected district',
      },
    };
  }

  const chargeRules = applyShippingChargeRules({
    baseCharge: zoneSettings.charge,
    itemsTotal,
    discountAmount,
    threshold: settings.freeDeliveryThreshold,
    promotionFreeDelivery,
  });

  return {
    normalizedAddress,
    zone: normalizedAddress.deliveryZone,
    baseCharge: zoneSettings.charge,
    ...chargeRules,
    estimatedMinDays: zoneSettings.estimatedMinDays,
    estimatedMaxDays: zoneSettings.estimatedMaxDays,
    availability: {
      available: true,
    },
  };
};

export const resolveShippingQuote = async ({
  address,
  itemsTotal,
  discountAmount,
  promotionFreeDelivery = false,
  session,
}: ResolveShippingInput): Promise<ShippingResolution & { normalizedAddress: NormalizedShippingQuoteAddress }> => {
  const normalizedAddress = validateAndNormalizeShippingQuoteAddress(address);
  const settings = await getShippingSettings(session);
  const zoneSettings = settings.zones[normalizedAddress.deliveryZone];

  if (!zoneSettings.enabled) {
    return {
      normalizedAddress,
      zone: normalizedAddress.deliveryZone,
      baseCharge: zoneSettings.charge,
      finalCharge: 0,
      isFreeDelivery: false,
      estimatedMinDays: zoneSettings.estimatedMinDays,
      estimatedMaxDays: zoneSettings.estimatedMaxDays,
      availability: {
        available: false,
        message: 'Delivery is currently unavailable for the selected district',
      },
    };
  }

  const chargeRules = applyShippingChargeRules({
    baseCharge: zoneSettings.charge,
    itemsTotal,
    discountAmount,
    threshold: settings.freeDeliveryThreshold,
    promotionFreeDelivery,
  });

  return {
    normalizedAddress,
    zone: normalizedAddress.deliveryZone,
    baseCharge: zoneSettings.charge,
    ...chargeRules,
    estimatedMinDays: zoneSettings.estimatedMinDays,
    estimatedMaxDays: zoneSettings.estimatedMaxDays,
    availability: {
      available: true,
    },
  };
};
