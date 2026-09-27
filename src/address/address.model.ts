import mongoose, { Document, Schema } from 'mongoose';
import { DeliveryZone } from '../order/order.model';

/**
 * A customer's saved delivery address (address book entry).
 *
 * `division` / `district` / `area` are kept as structured fields because the
 * existing shipping engine (`shipping-zone-policy.ts`) resolves the delivery
 * zone from them. `fullAddress` holds the free-form street address.
 */
export interface IAddress {
    user: mongoose.Types.ObjectId;
    name: string;
    phone: string;
    division: string;
    district: string;
    area: string;
    fullAddress: string;
    landmark?: string;
    deliveryZone: DeliveryZone;
    isDefault: boolean;
}

export interface IAddressDocument extends IAddress, Document {
    createdAt: Date;
    updatedAt: Date;
}

const AddressSchema = new Schema<IAddressDocument>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Customer reference is required'],
            index: true,
        },
        name: {
            type: String,
            required: [true, 'Recipient name is required'],
            trim: true,
            minlength: [2, 'Recipient name must be at least 2 characters'],
        },
        phone: {
            type: String,
            required: [true, 'Phone number is required'],
            trim: true,
        },
        division: {
            type: String,
            required: [true, 'Division is required'],
            trim: true,
        },
        district: {
            type: String,
            required: [true, 'District is required'],
            trim: true,
        },
        area: {
            type: String,
            required: [true, 'Area / Thana is required'],
            trim: true,
        },
        fullAddress: {
            type: String,
            required: [true, 'Full address is required'],
            trim: true,
            minlength: [5, 'Full address must be at least 5 characters'],
        },
        landmark: {
            type: String,
            trim: true,
            default: undefined,
        },
        deliveryZone: {
            type: String,
            enum: ['inside_dhaka', 'dhaka_suburban', 'outside_dhaka'],
            required: true,
        },
        isDefault: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                const r = ret as unknown as Record<string, unknown> & {
                    _id?: { toString: () => string };
                    user?: { toString: () => string };
                };

                if (r._id) {
                    r.id = r._id.toString();
                    delete r._id;
                }

                delete r.__v;

                if (r.user) {
                    r.userId = r.user.toString();
                }

                return r;
            },
        },
    }
);

// A customer can have at most one default address.
// The partial filter keeps non-default addresses out of the unique constraint.
AddressSchema.index(
    { user: 1, isDefault: 1 },
    { unique: true, partialFilterExpression: { isDefault: true } }
);

export const Address =
    mongoose.models.Address || mongoose.model<IAddressDocument>('Address', AddressSchema);

export default Address;
