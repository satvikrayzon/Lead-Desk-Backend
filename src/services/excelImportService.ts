import ExcelJS from 'exceljs';
import { Lead, LeadAssignment, LeadImportBatch } from '../models';
import { ImportErrorRow } from '../models/LeadImportBatch';

const HEADER_MAP: Record<string, string> = {
  // State / location
  state: 'state',
  district: 'district',
  city: 'city',

  // Vendor / company identity
  vendorid: 'vendorId',
  vendorcode: 'vendorId',
  vendorno: 'vendorId',
  firmcode: 'vendorId',
  vendorname: 'companyName',
  firmname: 'companyName',
  companyname: 'companyName',
  company: 'companyName',
  firm: 'companyName',
  name: 'companyName',

  // Contact
  contactperson: 'contactPerson',
  personname: 'contactPerson',
  contactname: 'contactPerson',
  contactemail: 'contactEmail',
  email: 'contactEmail',
  emailid: 'contactEmail',
  mail: 'contactEmail',
  contactmobile: 'contactMobile',
  mobilenumber: 'contactMobile',
  mobile: 'contactMobile',
  phone: 'contactMobile',
  phonenumber: 'contactMobile',
  contactno: 'contactMobile',
  contactnumber: 'contactMobile',
  mobileno: 'contactMobile',
  cellphone: 'contactMobile',

  // Other vendor fields
  address: 'address',
  website: 'website',
  rating: 'rating',
  ratingcount: 'ratingCount',
  installedcapacitykwp: 'currentInstallationCapacityKw',
  installedcapacity: 'currentInstallationCapacityKw',
  capacitykwp: 'currentInstallationCapacityKw',
  capacitykw: 'currentInstallationCapacityKw',
  installationscount: 'installationsCount',
};

function normalizeHeader(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cellText(cell: ExcelJS.CellValue | null | undefined): string | null {
  if (cell == null) return null;
  if (typeof cell === 'object' && 'text' in cell && cell.text != null) return String(cell.text).trim();
  if (typeof cell === 'object' && 'result' in cell && cell.result != null) {
    return cellText(cell.result as ExcelJS.CellValue);
  }
  if (cell instanceof Date) return cell.toISOString();
  // Avoid scientific notation for phone-like numbers from Excel.
  if (typeof cell === 'number' && Number.isFinite(cell) && Math.abs(cell) >= 1e9) {
    return Math.round(cell).toString();
  }
  return String(cell).trim();
}

function normalizeMobile(raw: string | null | undefined): string {
  if (!raw) return '';
  // Keep leading +, strip spaces/dashes/parens; leave digits.
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  return cleaned.replace(/\D/g, '');
}

function cellNumber(cell: ExcelJS.CellValue | null | undefined): number | null {
  const text = cellText(cell);
  if (!text) return null;
  const n = Number(text);
  return Number.isNaN(n) ? null : n;
}

type ImportRecord = Record<string, string | number | null | undefined>;

export async function importLeadsFromBuffer(params: {
  buffer: Buffer;
  originalFilename?: string;
  uploadedByUserId: string;
  assignToUserId: string;
}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(params.buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook has no sheets.');

  const headerRow = sheet.getRow(1);
  const columnIndexToField: Record<number, string> = {};
  headerRow.eachCell((cell, colNumber) => {
    const field = HEADER_MAP[normalizeHeader(cell.text || cell.value)];
    if (field) columnIndexToField[colNumber] = field;
  });

  if (Object.keys(columnIndexToField).length === 0) {
    throw new Error(
      'Could not recognize any columns. Expected headers like "Firm Name" / "Vendor Name", "Mobile Number" / "Contact Mobile", "District", "Vendor Code", etc.',
    );
  }

  const mappedFields = new Set(Object.values(columnIndexToField));
  if (!mappedFields.has('companyName') && !mappedFields.has('contactMobile')) {
    throw new Error(
      'Excel headers were found, but no firm/vendor name or mobile column was recognized. ' +
        'Use columns like "Firm Name" / "Vendor Name" and "Mobile Number" / "Contact Mobile".',
    );
  }

  const batch = await LeadImportBatch.create({
    uploadedByUserId: params.uploadedByUserId,
    originalFilename: params.originalFilename,
    totalRows: 0,
    createdCount: 0,
    skippedCount: 0,
    errorCount: 0,
    rowErrors: [],
  });

  let totalRows = 0;
  let createdCount = 0;
  let skippedCount = 0;
  const rowErrors: ImportErrorRow[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (row.cellCount === 0) continue;

    totalRows += 1;
    try {
      const record: ImportRecord = {};
      for (const [colIndex, field] of Object.entries(columnIndexToField)) {
        const cell = row.getCell(Number(colIndex)).value;
        const isNumeric = ['rating', 'ratingCount', 'currentInstallationCapacityKw', 'installationsCount'].includes(field);
        record[field] = isNumeric ? cellNumber(cell) : cellText(cell);
      }

      const companyName = (record.companyName as string) || (record.contactPerson as string) || '';
      const contactMobile = normalizeMobile(record.contactMobile as string | null | undefined);

      if (!companyName && !contactMobile) {
        totalRows -= 1;
        continue;
      }
      if (!contactMobile) {
        throw new Error('Missing Contact Mobile / Mobile Number.');
      }

      if (record.vendorId) {
        const existing = await Lead.findOne({ vendorId: String(record.vendorId) });
        if (existing) {
          skippedCount += 1;
          continue;
        }
      }

      const district = record.district ? String(record.district) : undefined;
      const city = record.city ? String(record.city) : district;

      const lead = await Lead.create({
        vendorId: record.vendorId ? String(record.vendorId) : undefined,
        companyName: companyName || 'Unknown Vendor',
        contactPerson: record.contactPerson ? String(record.contactPerson) : undefined,
        contactEmail: record.contactEmail ? String(record.contactEmail) : undefined,
        contactMobile,
        address: record.address ? String(record.address) : undefined,
        website: record.website ? String(record.website) : undefined,
        rating: record.rating as number | undefined,
        ratingCount: record.ratingCount as number | undefined,
        currentInstallationCapacityKw: record.currentInstallationCapacityKw as number | undefined,
        installationsCount: record.installationsCount as number | undefined,
        state: record.state ? String(record.state) : undefined,
        district,
        city,
        name: (record.contactPerson as string) || companyName || 'Unknown',
        phoneNumber: contactMobile,
        company: companyName || undefined,
        importBatchId: batch._id,
        leadStatus: 'open',
        leadStage: 'not_contacted',
        callCount: 0,
      });

      await LeadAssignment.create({
        leadId: lead._id,
        agentId: params.assignToUserId,
        assignedBy: params.uploadedByUserId,
        isActive: true,
      });

      createdCount += 1;
    } catch (err) {
      rowErrors.push({ row: rowNumber, message: err instanceof Error ? err.message : 'Import failed.' });
    }
  }

  batch.totalRows = totalRows;
  batch.createdCount = createdCount;
  batch.skippedCount = skippedCount;
  batch.errorCount = rowErrors.length;
  batch.rowErrors = rowErrors;
  await batch.save();

  return batch;
}

export function formatImportBatch(batch: {
  _id: { toString(): string };
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  rowErrors: ImportErrorRow[];
}) {
  return {
    id: batch._id.toString(),
    total_rows: batch.totalRows,
    created_count: batch.createdCount,
    skipped_count: batch.skippedCount,
    error_count: batch.errorCount,
    errors: batch.rowErrors,
  };
}
