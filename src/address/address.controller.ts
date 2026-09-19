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
        const address = await updateCustomerAddress(
            req.user.id,
            readParam(req.params.id),
            req.body as AddressPayload
        );
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
        const result = await deleteCustomerAddress(req.user.id, readParam(req.params.id));
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
        const address = await setCustomerDefaultAddress(req.user.id, readParam(req.params.id));
        res.status(200).json({ success: true, message: 'Default address updated', address });
    } catch (error) {
        respondWithError(res, error, 'Unable to set the default address', 'address_default_failed');
    }
};
