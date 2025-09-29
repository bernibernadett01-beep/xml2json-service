import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { XMLParser } from "fast-xml-parser";

dotenv.config();

const app = express();

// CORS – permite apeluri din Bubble
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

// Multer pentru upload de fișiere
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.XML_MAX_SIZE || "5242880", 10) } // 5MB
});

// Parser XML
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: true
});

// Utils sigure pentru conversii
const toNum = (val) => {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().replace(/\s+/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const toVatRate = (v) => {
  // Acceptă 19 sau 0.19 și normalizează la fracție (0.19)
  const n = toNum(v);
  if (n === null) return null;
  return n > 1 ? +(n / 100).toFixed(4) : +n.toFixed(4);
};

const safeGet = (obj, path, fallback = null) =>
  path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : null), obj) ?? fallback;

// Încearcă să detecteze structuri UBL și generice
function mapInvoiceToStandard(json) {
  // Căutăm rădăcina: UBL <Invoice> sau generic <invoice>
  const root = json.Invoice || json.invoice || json["ns2:Invoice"] || json["ns3:Invoice"] || json;
  if (!root) {
    return { ok: false, error: "No Invoice root found" };
  }

  // Header – încearcă mai multe căi
  const supplierName =
    safeGet(root, "AccountingSupplierParty.Party.PartyName.Name") ||
    safeGet(root, "accountingSupplierParty.party.partyName.name") ||
    safeGet(root, "Supplier.Name") ||
    safeGet(root, "supplier.name");

  const supplierCUI =
    safeGet(root, "AccountingSupplierParty.Party.PartyTaxScheme.CompanyID") ||
    safeGet(root, "accountingSupplierParty.party.partyTaxScheme.companyID") ||
    safeGet(root, "Supplier.CUI") ||
    safeGet(root, "supplier.cui");

  const invoiceNumber =
    safeGet(root, "ID") ||
    safeGet(root, "id") ||
    safeGet(root, "InvoiceNumber") ||
    safeGet(root, "invoiceNumber");

  const invoiceDate =
    safeGet(root, "IssueDate") ||
    safeGet(root, "issueDate") ||
    safeGet(root, "InvoiceDate") ||
    safeGet(root, "invoiceDate");

  const currency =
    safeGet(root, "DocumentCurrencyCode") ||
    safeGet(root, "documentCurrencyCode") ||
    safeGet(root, "Currency") ||
    safeGet(root, "currency");

  // Totale
  const legalMonetary = safeGet(root, "LegalMonetaryTotal") || safeGet(root, "legalMonetaryTotal") || {};
  const lineExtensionAmount =
    toNum(legalMonetary.LineExtensionAmount?.["#text"] ?? legalMonetary.LineExtensionAmount) ||
    toNum(safeGet(root, "totals.lineExtensionAmount"));

  const taxExclusiveAmount =
    toNum(legalMonetary.TaxExclusiveAmount?.["#text"] ?? legalMonetary.TaxExclusiveAmount) ||
    toNum(safeGet(root, "totals.taxExclusive"));

  const taxInclusiveAmount =
    toNum(legalMonetary.TaxInclusiveAmount?.["#text"] ?? legalMonetary.TaxInclusiveAmount) ||
    toNum(safeGet(root, "totals.taxInclusive"));

  const allowanceTotalAmount =
    toNum(legalMonetary.AllowanceTotalAmount?.["#text"] ?? legalMonetary.AllowanceTotalAmount) ||
    null;

  // Liniile – suportă UBL InvoiceLine[] sau generic lines/Items
  let rawLines =
    root.InvoiceLine || root.invoiceLine || root.Lines || root.lines || root.Items || root.items || [];

  if (!Array.isArray(rawLines)) rawLines = [rawLines];

  const items = rawLines
    .filter(Boolean)
    .map((ln, idx) => {
      // Denumire produs
      const name =
        safeGet(ln, "Item.Name") ||
        safeGet(ln, "item.name") ||
        safeGet(ln, "Description") ||
        safeGet(ln, "description") ||
        `Item ${idx + 1}`;

      // U.M.
      const unit =
        safeGet(ln, "InvoicedQuantity.@_unitCode") ||
        safeGet(ln, "invoicedQuantity.@_unitCode") ||
        safeGet(ln, "Unit") ||
        safeGet(ln, "unit") ||
        null;

      // Cantitate facturată
      const qtyInvoiced =
        toNum(ln.InvoicedQuantity?.["#text"] ?? ln.InvoicedQuantity) ??
        toNum(ln.invoicedQuantity?.["#text"] ?? ln.invoicedQuantity) ??
        toNum(ln.Quantity ?? ln.quantity);

      // Preț unitar fără TVA
      const priceNoVat =
        toNum(ln.Price?.PriceAmount?.["#text"] ?? ln.Price?.PriceAmount) ??
        toNum(ln.price?.priceAmount?.["#text"] ?? ln.price?.priceAmount) ??
        toNum(ln.UnitPrice ?? ln.unitPrice);

      // Cota TVA (caută în TaxTotal → TaxCategory → Percent)
      const vatPercent =
        toNum(
          safeGet(ln, "TaxTotal.TaxSubtotal.TaxCategory.Percent") ??
            safeGet(ln, "taxTotal.taxSubtotal.taxCategory.percent")
        ) ??
        toNum(safeGet(ln, "VAT") ?? safeGet(ln, "vat"));

      const vatRate = vatPercent !== null ? toVatRate(vatPercent) : null;

      // Valori derivate (fără TVA / TVA)
      const valueNoVat =
        qtyInvoiced !== null && priceNoVat !== null ? +(qtyInvoiced * priceNoVat).toFixed(4) : null;
      const vatValue =
        valueNoVat !== null && vatRate !== null ? +(valueNoVat * vatRate).toFixed(4) : null;

      return {
        product_name: name,
        unit: unit,
        qty_invoiced: qtyInvoiced,
        // qty_received: NULL — se completează în Bubble
        qty_received: null,
        lot: null,
        price_no_vat: priceNoVat,
        vat_rate: vatRate,
        value_no_vat: valueNoVat,
        vat_value: vatValue
      };
    });

  const header = {
    supplier: supplierName || null,
    cui: supplierCUI || null,
    invoice_number: invoiceNumber || null,
    invoice_date: invoiceDate || null,
    currency: currency || null,
    total_no_vat: taxExclusiveAmount ?? lineExtensionAmount ?? null,
    total_with_vat: taxInclusiveAmount ?? null,
    allowance_total: allowanceTotalAmount
  };

  return { ok: true, header, items };
}

// Health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// XML ca RAW text
app.post("/api/xml2json", express.text({ type: ["text/*", "application/xml"], limit: process.env.XML_MAX_SIZE || "5mb" }), (req, res) => {
  try {
    if (!req.body) return res.status(400).json({ ok: false, error: "Empty body" });
    const json = parser.parse(req.body);
    const mapped = mapInvoiceToStandard(json);
    if (!mapped.ok) return res.status(422).json(mapped);
    return res.json(mapped);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "Parse error" });
  }
});

// XML ca fișier (multipart form-data, field name: file)
app.post("/api/xml2json_file", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const xml = req.file.buffer.toString("utf8");
    const json = parser.parse(xml);
    const mapped = mapInvoiceToStandard(json);
    if (!mapped.ok) return res.status(422).json(mapped);
    return res.json(mapped);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "Parse error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("xml2json service running on port", PORT);
});
