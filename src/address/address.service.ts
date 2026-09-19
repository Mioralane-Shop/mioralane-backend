import mongoose from 'mongoose';
import { Address, IAddressDocument } from './address.model';
import { validateAndNormalizeShippingAddress } from '../shipping/shipping.service';

type HttpError = Error & { statusCode?: number; code?: string };

/** Payload accepted by the address book endpoints. */
export type AddressPayload = {
    name?: string;
    phone?: string;
    division?: string;
    district?: string;
    area?: string;
    thana?: string;
    fullAddress?: string;
    address?: string;
    detailedAddress?: string;
    landmark?: string;
    isDefault?: boolean | string;
};

const createAddressError = (statusCode: number, message: string, code?: string): HttpError => {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const invalidAddressIdError = (): HttpError =>
    createAddressError(400, 'Invalid address ID', 'invalid_address_id');

/** Ownership violations surface as 404 so foreign IDs are not confirmed. */
const addressNotFoundError = (): HttpError =>
    createAddressError(404, 'Address not found', 'address_not_found');

const readString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

const readBoolean = (value: unknown): boolean => value === true || value === 'true';

const readExplicitFalse = (value: unknown): boolean => value === false || value === 'false';

type AddressFieldFallback = {
    name?: string;
    phone?: string;
    division?: string;
    district?: string;
    area?: string;
    fullAddress?: string;
    landmark?: string;
};

/**
 * Merges an incoming payload over an optional existing address, then runs the
 * shared shipping validator so the address book uses the exact same
 * field/phone/zone rules as checkout.
 */
const normalizeAddressPayload = (payload: AddressPayload | undefined, fallback: AddressFieldFallback) => {
    const fullAddress =
        readString(payload?.fullAddress) ?? readString(payload?.detailedAddress) ?? readString(payload?.address);

    return validateAndNormalizeShippingAddress({
        name: readString(payload?.name) ?? fallback.name,
        phone: readString(payload?.phone) ?? fallback.phone,
        division: readString(payload?.division) ?? fallback.division,
        district: readString(payload?.district) ?? fallback.district,
        area: readString(payload?.area) ?? readString(payload?.thana) ?? fallback.area,
        address: fullAddress ?? fallback.fullAddress,
        landmark: payload?.landmark !== undefined ? readString(payload?.landmark) : fallback.landmark,
    });
};

export const toAddressObjectId = (addressId: string): mongoose.Types.ObjectId => {
    if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
        throw invalidAddressIdError();
    }

    return new mongoose.Types.ObjectId(addressId);
};

/**
 * Loads an address that is guaranteed to belong to the authenticated customer.
 * Never trust a `userId` coming from the client.
 */
export const findOwnedAddress = async (
    userId: string,
    addressId: string
): Promise<IAddressDocument> => {
    const objectId = toAddressObjectId(addressId);
    const address = await Address.findOne({ _id: objectId, user: userId });

    if (!address) {
        throw addressNotFoundError();
    }

    return address;
};

export const listCustomerAddresses = async (userId: string): Promise<IAddressDocument[]> =>
    Address.find({ user: userId }).sort({ isDefault: -1, updatedAt: -1 });

export const createCustomerAddress = async (
    userId: string,
    payload: AddressPayload | undefined
): Promise<IAddressDocument> => {
    const normalized = normalizeAddressPayload(payload, {});
    const existingCount = await Address.countDocuments({ user: userId });

    // The very first address always becomes the default so checkout has one.
    const shouldBeDefault = readBoolean(payload?.isDefault) || existingCount === 0;

    if (shouldBeDefault) {
        await Address.updateMany({ user: userId, isDefault: true }, { isDefault: false });
    }

    return Address.create({
        user: new mongoose.Types.ObjectId(userId),
        name: normalized.name,
        phone: normalized.phone,
        division: normalized.division,
        district: normalized.district,
        area: normalized.area,
        fullAddress: normalized.address,
        landmark: normalized.landmark,
        deliveryZone: normalized.deliveryZone,
        isDefault: shouldBeDefault,
    });
};

export const updateCustomerAddress = async (
    userId: string,
    addressId: string,
    payload: AddressPayload | undefined
): Promise<IAddressDocument> => {
    const address = await findOwnedAddress(userId, addressId);

    const normalized = normalizeAddressPayload(payload, {
        name: address.name,
        phone: address.phone,
        division: address.division,
        district: address.district,
        area: address.area,
        fullAddress: address.fullAddress,
        landmark: address.landmark,
    });

    // A customer must always keep one default address — ask them to move the
    // default flag to another address instead of leaving the account without one.
    if (readExplicitFalse(payload?.isDefault) && address.isDefault) {
        throw createAddressError(
            400,
            'Set another address as the default before unsetting this one',
            'default_address_required'
        );
    }

    address.name = normalized.name;
    address.phone = normalized.phone;
    address.division = normalized.division;
    address.district = normalized.district;
    address.area = normalized.area;
    address.fullAddress = normalized.address;
    address.landmark = normalized.landmark;
    address.deliveryZone = normalized.deliveryZone;

    if (readBoolean(payload?.isDefault) && !address.isDefault) {
        await Address.updateMany(
            { user: userId, _id: { $ne: address._id }, isDefault: true },
            { isDefault: false }
        );
        address.isDefault = true;
    }

    await address.save();

    return address;
};

export const deleteCustomerAddress = async (
    userId: string,
    addressId: string
): Promise<{ addressId: string; promotedDefaultAddressId?: string }> => {
    const address = await findOwnedAddress(userId, addressId);
    const deletedId = address._id.toString();
    const wasDefault = address.isDefault;

    await address.deleteOne();

    let promotedDefaultAddressId: string | undefined;

    // Never leave the account with inconsistent default state: promote the most
    // recently updated remaining address when the default one is deleted.
    if (wasDefault) {
        const nextDefault = await Address.findOne({ user: userId }).sort({ updatedAt: -1, createdAt: -1 });

        if (nextDefault) {
            nextDefault.isDefault = true;
            await nextDefault.save();
            promotedDefaultAddressId = nextDefault._id.toString();
        }
    }

    return { addressId: deletedId, promotedDefaultAddressId };
};

export const setCustomerDefaultAddress = async (
    userId: string,
    addressId: string
): Promise<IAddressDocument> => {
    const address = await findOwnedAddress(userId, addressId);

    if (!address.isDefault) {
        await Address.updateMany(
            { user: userId, _id: { $ne: address._id }, isDefault: true },
            { isDefault: false }
        );
        address.isDefault = true;
        await address.save();
    }

    return address;
};

/**
 * Server-derived shipping input for order creation. The client only sends the
 * saved address id; every field is read back from the owned document.
 */
export const resolveSavedAddressForCheckout = async (
    userId: string,
    addressId: string
): Promise<{
    name: string;
    phone: string;
    division: string;
    district: string;
    area: string;
    address: string;
    landmark?: string;
}> => {
    const address = await findOwnedAddress(userId, addressId);

    return {
        name: address.name,
        phone: address.phone,
        division: address.division,
        district: address.district,
        area: address.area,
        address: address.fullAddress,
        landmark: address.landmark,
    };
};

export { createAddressError };
