import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
    AddressPayload,
    createCustomerAddress,
    deleteCustomerAddress,
    findOwnedAddress,
    listCustomerAddresses,
    setCustomerDefaultAddress,
    updateCustomerAddress,
} from './address.service';
import {
    buildActivityChanges,
    pickActivitySnapshot,
    recordActivity,
} from '../activity-log/activity-log.service';

/**
 * Location summary only: the street line, landmark and phone number are
 * deliberately left out of the audit snapshot to limit stored PII.
 */
const ADDRESS_AUDIT_FIELDS = ['division', 'district', 'area', 'deliveryZone', 'isDefault'];

const readAddressId = (address: unknown): string => {
    const record = (address ?? {}) as { id?: string; _id?: { toString: () => string } };

    if (record.id) {
        return record.id;
    }

    return record._id ? record._id.toString() : '';
};

const describeAddress = (address: unknown): string | undefined => {
    const record = (address ?? {}) as { area?: string; district?: string; division?: string };
    const parts = [record.area, record.district, record.division].filter(
        (part): part is string => typeof part === 'string' && part.trim() !== ''
    );

    return parts.length > 0 ? parts.join(', ') : undefined;
};

const addressAuditSnapshot = (address: unknown) =>
    pickActivitySnapshot(address, ADDRESS_AUDIT_FIELDS);

const respondWithError = (
    res: Response,
    error: unknown,
    fallbackMessage: string,
    fallbackCode: string
): void => {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
        success: false,
        message: err.message ?? fallbackMessage,
        code: err.code ?? fallbackCode,
    });
};

const readParam = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export const listMyAddresses = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const addresses = await listCustomerAddresses(req.user.id);
        res.status(200).json({ success: true, count: addresses.length, addresses });
    } catch (error) {
        respondWithError(res, error, 'Unable to load your addresses', 'address_list_failed');
    }
};

export const createMyAddress = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const address = await createCustomerAddress(req.user.id, req.body as AddressPayload);
        const plain = address.toObject();

        await recordActivity(req, {
            action: 'CREATE',
            entityType: 'ADDRESS',
            entityId: readAddressId(plain),
            entityName: describeAddress(plain),
            description: `Saved a new delivery address${describeAddress(plain) ? ` (${describeAddress(plain)})` : ''}`,
            after: addressAuditSnapshot(plain),
        });

        res.status(201).json({ success: true, message: 'Address saved', address });
    } catch (error) {
        respondWithError(res, error, 'Unable to save this address', 'address_create_failed');
    }
};

export const getMyAddress = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const address = await findOwnedAddress(req.user.id, readParam(req.params.id));
        res.status(200).json({ success: true, address });
    } catch (error) {
        respondWithError(res, error, 'Unable to load this address', 'address_fetch_failed');
    }
};

export const updateMyAddress = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const addressId = readParam(req.params.id);
        const existing = await findOwnedAddress(req.user.id, addressId);
        const beforeSnapshot = addressAuditSnapshot(existing.toObject());

        const address = await updateCustomerAddress(
            req.user.id,
            addressId,
            req.body as AddressPayload
        );

        const changes = buildActivityChanges(beforeSnapshot, addressAuditSnapshot(address.toObject()));

        if (changes.changedFields.length > 0) {
            await recordActivity(req, {
                action: 'UPDATE',
                entityType: 'ADDRESS',
                entityId: addressId,
                entityName: describeAddress(address.toObject()),
                before: changes.before,
                after: changes.after,
                metadata: { changedFields: changes.changedFields },
            });
        }

        res.status(200).json({ success: true, message: 'Address updated', address });
    } catch (error) {
        respondWithError(res, error, 'Unable to update this address', 'address_update_failed');
    }
};

export const deleteMyAddress = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const addressId = readParam(req.params.id);
        const existing = await findOwnedAddress(req.user.id, addressId);
        const plain = existing.toObject();

        const result = await deleteCustomerAddress(req.user.id, addressId);

        await recordActivity(req, {
            action: 'DELETE',
            entityType: 'ADDRESS',
            entityId: addressId,
            entityName: describeAddress(plain),
            description: `Removed a delivery address${describeAddress(plain) ? ` (${describeAddress(plain)})` : ''}`,
            before: addressAuditSnapshot(plain),
        });

        res.status(200).json({ success: true, message: 'Address removed', ...result });
    } catch (error) {
        respondWithError(res, error, 'Unable to remove this address', 'address_delete_failed');
    }
};

export const setMyDefaultAddress = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const addressId = readParam(req.params.id);
        const existing = await findOwnedAddress(req.user.id, addressId);
        const wasDefault = Boolean((existing.toObject() as { isDefault?: boolean }).isDefault);

        const address = await setCustomerDefaultAddress(req.user.id, addressId);
        const summary = describeAddress(address.toObject());

        await recordActivity(req, {
            action: 'STATUS_CHANGE',
            entityType: 'ADDRESS',
            entityId: addressId,
            entityName: summary,
            description: `Set the default delivery address${summary ? ` to ${summary}` : ''}`,
            before: { isDefault: wasDefault },
            after: { isDefault: true },
        });

        res.status(200).json({ success: true, message: 'Default address updated', address });
    } catch (error) {
        respondWithError(res, error, 'Unable to set the default address', 'address_default_failed');
    }
};
