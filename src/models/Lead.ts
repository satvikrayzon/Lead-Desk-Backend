import mongoose, { Schema, Document, Model } from 'mongoose';

import { LeadStatus } from '../types/enums';



export interface ILead extends Document {

  name: string;

  phoneNumber: string;

  company?: string;

  status: LeadStatus;

  notes?: string;

  vendorId?: string;

  companyName?: string;

  contactPerson?: string;

  contactEmail?: string;

  contactMobile?: string;

  address?: string;

  website?: string;

  rating?: number;

  ratingCount?: number;

  currentInstallationCapacityKw?: number;

  installationsCount?: number;

  state?: string;

  district?: string;

  city?: string;

  callCount?: number;

  lastCalledAt?: Date;

  importBatchId?: mongoose.Types.ObjectId;



  // Tracker identity (Sales_Lead_Tracker Lead_Data)

  leadCode?: string;

  leadDate?: Date;

  salesExecutive?: string;

  teamLeader?: string;



  designation?: string;

  customerType?: string;

  customerSource?: string;

  product?: string;

  requirementKw?: number;

  requirementDate?: Date;

  currentBrand?: string;

  currentSupplier?: string;

  expectedPrice?: number;

  deliveryLocation?: string;

  leadStatus?: string;

  leadStage?: string;

  priority?: string;

  dealerDirect?: string;

  assignedDealer?: string;

  quotationDate?: Date;

  quotationValue?: number;

  expectedOrderDate?: Date;

  probabilityPercent?: number;

  lastContactDate?: Date;

  nextFollowupDate?: Date;

  followupRemarks?: string;

  followup2Date?: Date;

  followup2?: string;

  followup3Date?: Date;

  followup3?: string;

  lostReason?: string;

  orderDate?: Date;

  orderValue?: number;

  orderKw?: number;

  remarks?: string;

  /** Most recent follow-up form fill time (seconds). */
  lastFormFillSeconds?: number;

  /** Average follow-up form fill time across entries (seconds). */
  avgFormFillSeconds?: number;

  createdAt: Date;

  updatedAt: Date;

}



const leadSchema = new Schema<ILead>(

  {

    name: { type: String, required: true },

    phoneNumber: { type: String, required: true, index: true },

    company: { type: String },

    status: {

      type: String,

      enum: ['new', 'interested', 'not_reachable', 'follow_up', 'not_interested', 'converted'],

      default: 'new',

    },

    notes: { type: String },

    vendorId: { type: String, index: true, sparse: true },

    companyName: { type: String },

    contactPerson: { type: String },

    contactEmail: { type: String },

    contactMobile: { type: String },

    address: { type: String },

    website: { type: String },

    rating: { type: Number },

    ratingCount: { type: Number },

    currentInstallationCapacityKw: { type: Number },

    installationsCount: { type: Number },

    state: { type: String },

    district: { type: String },

    city: { type: String },

    callCount: { type: Number, default: 0 },

    lastCalledAt: { type: Date },

    importBatchId: { type: Schema.Types.ObjectId, ref: 'LeadImportBatch' },



    leadCode: { type: String, index: true, sparse: true },

    leadDate: { type: Date },

    salesExecutive: { type: String },

    teamLeader: { type: String },



    designation: { type: String },

    customerType: { type: String },

    customerSource: { type: String, default: 'Cold Calling' },

    product: { type: String },

    requirementKw: { type: Number },

    requirementDate: { type: Date },

    currentBrand: { type: String },

    currentSupplier: { type: String },

    expectedPrice: { type: Number },

    deliveryLocation: { type: String },

    leadStatus: { type: String, default: 'Open' },

    leadStage: { type: String },

    priority: { type: String },

    dealerDirect: { type: String },

    assignedDealer: { type: String },

    quotationDate: { type: Date },

    quotationValue: { type: Number },

    expectedOrderDate: { type: Date },

    probabilityPercent: { type: Number },

    lastContactDate: { type: Date },

    nextFollowupDate: { type: Date },

    followupRemarks: { type: String },

    followup2Date: { type: Date },

    followup2: { type: String },

    followup3Date: { type: Date },

    followup3: { type: String },

    lostReason: { type: String },

    orderDate: { type: Date },

    orderValue: { type: Number },

    orderKw: { type: Number },

    remarks: { type: String },

    lastFormFillSeconds: { type: Number },

    avgFormFillSeconds: { type: Number },

  },

  { timestamps: true }

);



export const Lead: Model<ILead> =

  mongoose.models.Lead || mongoose.model<ILead>('Lead', leadSchema);

